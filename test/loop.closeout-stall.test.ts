import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { runAgent } from "../src/acp";
import { RUNNER_LEASE_GRACE_MS } from "../src/runner-protocol";
import { JOB_KIND, type Clock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  enqueueJob,
  getLinkAsk,
  getRun,
  getWorkItem,
  listCloseoutRecoveries,
  listJobs,
  listWorkItems,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import { createFakeCloseoutGate, type CloseoutVerdict } from "../src/closeout";
import { createFakeGitHub } from "../src/github";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, type AgentLaunch } from "../src/loop";
import { findOpenQuestion } from "../src/questions";
import { githubClient } from "./e2e-harness";
import { workspaceAdmission } from "./fake-workspace";

const exec = promisify(execFile);
const fakeAgent = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const POLICY = `specVersion: "0.1"
items:
  - id: test
    kind: command
    gate: beforePR
    exec: ["true"]
    timeoutSeconds: 30
`;

/** PAS-629's verdict: the independent review failed and the fix did not land. */
function fixFailed(head: string): CloseoutVerdict {
  const summary = "Closeout: fix_failed\nindependent-review: failed";
  return {
    decision: "rejected",
    exhausted: false,
    summary,
    result: {
      outcome: "fix_failed",
      taskId: "ENG-7",
      base: "",
      head,
      fixAttempts: 1,
      evaluations: 1,
      exitCode: 1,
      summary,
      handoff: "Fix the P1 review finding.",
      decision: {
        specVersion: "0.1",
        decision: "rejected",
        gate: "beforePR",
        base: "",
        head,
        candidate: { session: "s", model: "m", provider: "p" },
        policy: { path: null, digest: null, absent: false },
        items: [
          { id: "test", kind: "command", state: "passed", message: "" },
          { id: "independent-review", kind: "review", state: "failed", message: "P1 finding" },
        ],
        warnings: [],
      },
    },
  };
}

test("a fix_failed verdict after the live operation was aborted restarts the item in the same job", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    expect(item.state).toBe("verifying");
    // As for PAS-629, an item.start job for the same item waits while this job verifies it.
    const second = enqueueJob(f.db, {
      queue: JOB_KIND.start,
      payload: { itemId: item.id },
      now: Date.now(),
    });
    // Something aborts the live operation without moving the item out of verifying.
    const interrupted = f.orchestrator.interruptLinearSession("ses_1");
    f.gate.next = fixFailed(f.gate.runs[0]!.headSha);
    f.release();
    await f.turn;
    await interrupted;

    expect(getWorkItem(f.db, item.id)?.state).toBe("queued");
    expect(restartReasons(f.db, item.id)).toEqual(["findings"]);
    const jobs = listJobs(f.db);
    // restart() fences the job that verified the item, and the pending item.start with it.
    expect(jobs.find((job) => job.id === f.jobId)?.status).toBe("cancelled");
    expect(jobs.find((job) => job.id === second)?.status).toBe("cancelled");
    expect(
      jobs.filter((job) => job.queue === JOB_KIND.resume && job.status === "pending"),
    ).toHaveLength(1);
    expect(f.stalls()).toEqual([]);
  } finally {
    await f.close();
  }
}, 90_000);

test("a job that ends with its item still in verifying journals why and asks for Closeout help", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    // The aborted Closeout run throws instead of returning a verdict.
    f.throwFromRun(new DOMException("The operation was aborted.", "AbortError"));
    const interrupted = f.orchestrator.interruptLinearSession("ses_1");
    f.release();
    await f.turn;
    await interrupted;
    await f.flush();

    expect(f.stalls()).toEqual([
      `job ${f.jobId} ${JOB_KIND.start} left item ${item.id} (ENG-7) in verifying: the job ended without a Closeout result`,
    ]);
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    expect(findOpenQuestion(f.db, "ses_1")?.kind).toBe("closeout-help");
    expect(listCloseoutRecoveries(f.db, item.id)).toHaveLength(1);
    expect(f.tracker.questions.at(-1)?.body).toContain(
      "Verification stopped without moving the task on: the job ended without a Closeout result.",
    );
  } finally {
    await f.close();
  }
}, 90_000);

test("a resume job claimed for an item in verifying journals and asks instead of ending silently", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    f.throwFromRun(new DOMException("The operation was aborted.", "AbortError"));
    // The first job's result is lost with its lease; a later run.resume finds the item in verifying.
    f.db.run("UPDATE job SET locked_by = 'lost' WHERE id = ?", [f.jobId]);
    f.release();
    await f.turn;
    expect(getWorkItem(f.db, item.id)?.state).toBe("verifying");
    expect(f.stalls()).toEqual([]);

    f.db.run("UPDATE job SET status = 'done', locked_by = NULL WHERE id = ?", [f.jobId]);
    const resume = enqueueJob(f.db, {
      queue: JOB_KIND.resume,
      payload: { itemId: item.id },
      now: Date.now(),
    });
    await f.tickAll();

    expect(f.stalls()).toEqual([
      `job ${resume} ${JOB_KIND.resume} left item ${item.id} (ENG-7) in verifying: the job ended without a Closeout result`,
    ]);
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    expect(findOpenQuestion(f.db, "ses_1")?.kind).toBe("closeout-help");
  } finally {
    await f.close();
  }
}, 90_000);

test("a reverify waits beside the turn's own Closeout and needs no second Closeout", async () => {
  const f = await verifyingWithHeldGate({ remote: true });
  try {
    const item = listWorkItems(f.db)[0]!;
    const runId = item.currentRunId!;
    const jobId = enqueueJob(f.db, {
      queue: JOB_KIND.reverify,
      payload: { itemId: item.id },
      maxAttempts: 1,
      now: Date.now(),
    });
    // Reproduce a duplicate dispatched outside the ordinary same-item claim exclusion.
    f.db.run("UPDATE job SET queue='held-test-turn' WHERE id=?", [f.jobId]);
    await f.tickReverify();
    f.db.run("UPDATE job SET queue=? WHERE id=?", [JOB_KIND.start, f.jobId]);

    expect(listJobs(f.db).find((job) => job.id === jobId)).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: null,
    });
    expect(f.gate.runs).toHaveLength(1);
    expect(getWorkItem(f.db, item.id)).toMatchObject({ state: "verifying", currentRunId: runId });
    expect(f.stalls()).toEqual([]);
    expect(findOpenQuestion(f.db, "ses_1")).toBeNull();

    f.release();
    await f.turn;
    expect(getWorkItem(f.db, item.id)?.state).toBe("merge_queue");
    f.db.run("UPDATE job SET run_at=0 WHERE id=?", [jobId]);
    await f.tickReverify();
    expect(listJobs(f.db).find((job) => job.id === jobId)?.status).toBe("done");
    expect(f.gate.runs).toHaveLength(1);
  } finally {
    f.release();
    await f.turn;
    await f.close();
  }
}, 90_000);

for (const hold of ["sibling", "live-decide"] as const)
  test(`a ${hold} hold preserves a decide request without spending attempts`, async () => {
    const f = await verifyingWithHeldGate({ remote: true });
    try {
      if (hold === "sibling") {
        f.release();
        await f.turn;
        await f.restart();
      }
      const item = listWorkItems(f.db)[0]!;
      // Reproduce the sibling context installed by the merge lane's hold().
      const contexts = (
        f.orchestrator as unknown as {
          jobContexts: Map<string, unknown>;
        }
      ).jobContexts;
      if (hold === "sibling") contexts.set(item.id, { isCurrent: () => true });
      const jobId = enqueueJob(f.db, {
        queue: JOB_KIND.reverify,
        payload: { itemId: item.id, decide: true },
        maxAttempts: 1,
        now: Date.now(),
      });
      f.db.run("UPDATE job SET queue='held-test-turn' WHERE id=?", [f.jobId]);
      await f.tickReverify();
      expect(listJobs(f.db).find((job) => job.id === jobId)).toMatchObject({
        status: "pending",
        attempts: 0,
        lastError: null,
        payload: { itemId: item.id, decide: true },
      });
      expect(f.gate.runs).toHaveLength(1);
      expect(f.gate.decisions).toHaveLength(0);
      expect(findOpenQuestion(f.db, "ses_1")).toBeNull();
      if (hold === "sibling") contexts.delete(item.id);
      else {
        f.release();
        await f.turn;
      }
      f.db.run("UPDATE job SET run_at=0 WHERE id=?", [jobId]);
      await f.tickReverify();
      expect(listJobs(f.db).find((job) => job.id === jobId)).toMatchObject({
        status: "done",
        attempts: 1,
        lastError: null,
      });
      // The live turn's accepted verdict can make the queued decision obsolete.
      expect(f.gate.decisions).toHaveLength(hold === "sibling" ? 1 : 0);
      expect(getWorkItem(f.db, item.id)?.state).toBe("merge_queue");
    } finally {
      f.release();
      await f.turn;
      await f.close();
    }
  }, 90_000);

test("a deferred duplicate survives an aborted live Closeout with its flags", async () => {
  const f = await verifyingWithHeldGate({ remote: true });
  try {
    const item = listWorkItems(f.db)[0]!;
    const jobId = enqueueJob(f.db, {
      queue: JOB_KIND.reverify,
      maxAttempts: 1,
      now: Date.now(),
      payload: { itemId: item.id, recheckHead: true, failClosed: true },
    });
    f.db.run("UPDATE job SET queue='held-test-turn' WHERE id=?", [f.jobId]);
    await f.tickReverify();
    expect(listJobs(f.db).find((job) => job.id === jobId)).toMatchObject({
      status: "pending",
      attempts: 0,
      payload: { itemId: item.id, recheckHead: true, failClosed: true },
    });
    f.throwFromRun(new DOMException("Lost original Closeout", "AbortError"));
    f.db.run("UPDATE job SET locked_by='lost' WHERE id=?", [f.jobId]);
    f.release();
    await f.turn;
    f.throwFromRun(null);
    f.db.run("UPDATE job SET status='done' WHERE id=?", [f.jobId]);
    f.db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [Date.now(), item.currentRunId!]);
    f.db.run("UPDATE job SET run_at=0 WHERE id=?", [jobId]);
    await f.tickReverify();
    expect(listJobs(f.db).find((job) => job.id === jobId)).toMatchObject({
      status: "done",
      lastError: null,
    });
    expect(getWorkItem(f.db, item.id)?.state).toBe("merge_queue");
    expect(f.gate.runs).toHaveLength(2);
  } finally {
    f.release();
    await f.turn;
    await f.close();
  }
}, 90_000);

for (const importResult of [true, false])
  test(`a delivered runner result survives lease grace with import success: ${importResult}`, async () => {
    const f = await verifyingWithHeldGate({ remote: true });
    try {
      f.release();
      await f.turn;
      await f.restart();
      const item = listWorkItems(f.db)[0]!;
      const runId = item.currentRunId!;
      f.db.run("UPDATE run SET status='active' WHERE id=?", [runId]);
      f.db.run("UPDATE work_item SET state='verifying' WHERE id=?", [item.id]);
      f.db.run("UPDATE runner_work SET ended_at=NULL, lease_until=? WHERE run_id=?", [
        Date.now() - RUNNER_LEASE_GRACE_MS - 1000,
        runId,
      ]);
      f.db.run(
        "INSERT INTO runner_command(id,runner_id,run_id,generation,kind,envelope,expires_at) SELECT command_id,runner_id,run_id,generation,'run','{}',? FROM runner_work WHERE run_id=?",
        [Date.now() + 60_000, runId],
      );
      f.db.run(
        "INSERT INTO runner_result(run_id,generation,command_id,payload,received_at) SELECT run_id,generation,command_id,'{}',? FROM runner_work WHERE run_id=?",
        [Date.now(), runId],
      );
      let imported = false;
      const verify = f.gate.run;
      f.gate.run = async (input) => {
        expect(getWorkItem(f.db, item.id)?.currentRunId).toBe(runId);
        expect(getRun(f.db, runId)?.status).toBe("active");
        expect(
          f.db.query("SELECT 1 FROM runner_work WHERE run_id=? AND ended_at IS NULL").get(runId),
        ).not.toBeNull();
        if (!importResult) throw new Error("fixture import interrupted");
        // The fake gate imports the delivered result, just as the remote backend does.
        f.db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [Date.now(), runId]);
        imported = true;
        return verify(input);
      };
      const jobId = enqueueJob(f.db, {
        queue: JOB_KIND.reverify,
        payload: { itemId: item.id },
        now: Date.now(),
        maxAttempts: 2,
      });
      await f.tickReverify();
      expect(imported).toBe(importResult);
      expect(listJobs(f.db).find((job) => job.id === jobId)?.status).toBe(
        importResult ? "done" : "pending",
      );
      expect(getWorkItem(f.db, item.id)).toMatchObject({
        state: importResult ? "merge_queue" : "verifying",
        currentRunId: runId,
      });
      expect(getRun(f.db, runId)?.status).toBe(importResult ? "ended" : "active");
      expect(
        f.db.query("SELECT 1 FROM runner_work WHERE run_id=? AND ended_at IS NULL").get(runId) !==
          null,
      ).toBe(!importResult);
    } finally {
      f.release();
      await f.turn;
      await f.close();
    }
  }, 90_000);

test("a prolonged sibling ownership hold asks for help instead of polling forever", async () => {
  const f = await verifyingWithHeldGate({ remote: true });
  try {
    f.release();
    await f.turn;
    await f.restart();
    const item = listWorkItems(f.db)[0]!;
    const contexts = (f.orchestrator as unknown as { jobContexts: Map<string, unknown> })
      .jobContexts;
    contexts.set(item.id, { isCurrent: () => true });
    const jobId = enqueueJob(f.db, {
      queue: JOB_KIND.reverify,
      now: Date.now(),
      maxAttempts: 1,
      payload: { itemId: item.id, verificationWaitSince: Date.now() - 20 * 60_000 },
    });
    await f.tickReverify();
    contexts.delete(item.id);
    expect(listJobs(f.db).find((job) => job.id === jobId)).toMatchObject({
      status: "done",
      lastError: null,
    });
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    expect(findOpenQuestion(f.db, "ses_1")?.body).toContain("20 minutes");
    expect(f.gate.runs).toHaveLength(1);
  } finally {
    f.release();
    await f.turn;
    await f.close();
  }
}, 90_000);

for (const state of ["verifying", "merge_queue"] as const)
  for (const lease of ["missing", "expired", "live", "grace"] as const)
    test(`a reverify after restart handles an active ${state} run with ${lease} runner work`, async () => {
      const f = await verifyingWithHeldGate({ remote: true });
      try {
        f.release();
        await f.turn;
        await f.restart();
        const item = listWorkItems(f.db)[0]!;
        const runId = item.currentRunId!;
        // Restore the rows a process restart can leave behind, with no in-memory owner.
        f.db.run("UPDATE run SET status='active' WHERE id=?", [runId]);
        f.db.run("UPDATE work_item SET state=? WHERE id=?", [state, item.id]);
        if (lease === "missing") f.db.run("DELETE FROM runner_work WHERE run_id=?", [runId]);
        else
          f.db.run("UPDATE runner_work SET ended_at=NULL, lease_until=? WHERE run_id=?", [
            Date.now() +
              (lease === "live"
                ? 60_000
                : lease === "grace"
                  ? -1_000
                  : -RUNNER_LEASE_GRACE_MS - 1_000),
            runId,
          ]);
        const jobId = enqueueJob(f.db, {
          queue: JOB_KIND.reverify,
          payload: { itemId: item.id },
          maxAttempts: 1,
          now: Date.now(),
        });
        await f.tickReverify();

        const waiting = lease === "live" || lease === "grace";
        expect(listJobs(f.db).find((job) => job.id === jobId)).toMatchObject({
          status: waiting ? "pending" : "done",
          attempts: waiting ? 0 : 1,
          lastError: null,
        });
        if (waiting) {
          expect(f.gate.runs).toHaveLength(1);
          expect(getRun(f.db, runId)?.status).toBe("active");
          expect(getWorkItem(f.db, item.id)).toMatchObject({ state, currentRunId: runId });
          // The same durable request must take over promptly once the lease expires.
          f.db.run("UPDATE runner_work SET lease_until=? WHERE run_id=?", [
            Date.now() - RUNNER_LEASE_GRACE_MS - 1_000,
            runId,
          ]);
          f.db.run("UPDATE job SET run_at=0 WHERE id=?", [jobId]);
          await f.tickReverify();
          expect(listJobs(f.db).find((job) => job.id === jobId)).toMatchObject({
            status: "done",
            attempts: 1,
            lastError: null,
          });
        }
        {
          expect(f.gate.runs).toHaveLength(2);
          expect(getRun(f.db, runId)?.status).toBe("lost");
          expect(
            f.db.query("SELECT 1 FROM runner_work WHERE run_id=? AND ended_at IS NULL").all(runId),
          ).toEqual([]);
          const current = getWorkItem(f.db, item.id)!;
          expect(current.state).toBe("merge_queue");
          expect(current.currentRunId).not.toBe(runId);
          expect(getRun(f.db, current.currentRunId!)).toMatchObject({
            kind: "recheck",
            status: "ended",
          });
        }
        expect(findOpenQuestion(f.db, "ses_1")).toBeNull();
        expect(f.stalls()).toEqual([]);
        expect(
          f.db
            .query(
              "SELECT 1 FROM work_item_event WHERE item_id=? AND event='closeout_infra_failed'",
            )
            .all(item.id),
        ).toEqual([]);
      } finally {
        f.release();
        await f.turn;
        await f.close();
      }
    }, 90_000);

/** Review attempts ran out at `head`: the independent review is exhausted, the rest passed. */
function reviewExhausted(head: string): CloseoutVerdict {
  const verdict = fixFailed(head);
  const summary = "Closeout: exhausted\nindependent-review: exhausted";
  return {
    ...verdict,
    decision: "rejected",
    exhausted: true,
    summary,
    result: {
      ...verdict.result!,
      outcome: "exhausted",
      summary,
      decision: {
        ...verdict.result!.decision!,
        items: [
          { id: "test", kind: "command", state: "passed", message: "" },
          {
            id: "independent-review",
            kind: "review",
            state: "exhausted",
            message: "4 of 4 allowed failed review attempts used. Stop retrying and ask for help.",
          },
        ],
      },
    },
  };
}

test("running out of review attempts asks on the item page instead of failing", async () => {
  const f = await verifyingWithHeldGate({ publicUrl: "https://paws.example" });
  try {
    const item = listWorkItems(f.db)[0]!;
    f.gate.next = reviewExhausted(f.gate.runs[0]!.headSha);
    f.release();
    await f.turn;
    await f.flush();

    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    const question = findOpenQuestion(f.db, "ses_1")!;
    expect(question.kind).toBe("link");
    expect(getLinkAsk(f.db, question.id)).toMatchObject({
      kind: "rounds",
      link: "https://paws.example/status/issues/ENG-7#review-rounds",
      rounds: { limit: 4, handoff: "Fix the P1 review finding." },
    });
    // The recovery row keeps the retry baseline a Rethink or Keep going grants.
    expect(listCloseoutRecoveries(f.db, item.id).map((entry) => entry.questionId)).toEqual([
      question.id,
    ]);
    const asked = f.tracker.questions.at(-1)!;
    expect(asked.options ?? []).toEqual([]);
    expect(asked.body).toContain(
      "Decide in Paws: https://paws.example/status/issues/ENG-7#review-rounds",
    );
  } finally {
    await f.close();
  }
}, 90_000);

test("a Paws without a public link asks in Linear when review attempts run out", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    f.gate.next = reviewExhausted(f.gate.runs[0]!.headSha);
    f.release();
    await f.turn;
    await f.flush();

    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    expect(findOpenQuestion(f.db, "ses_1")?.kind).toBe("closeout-help");
  } finally {
    await f.close();
  }
}, 90_000);

/** `api-contract`, a rule set to `onFail: approve`, broke at `head`; the `test` check passed or failed. */
function ruleBroke(head: string, check: "passed" | "failed" = "passed"): CloseoutVerdict {
  const verdict = fixFailed(head);
  const summary = "Closeout: exhausted\napi-contract: failed";
  return {
    decision: "rejected",
    exhausted: true,
    summary,
    result: {
      ...verdict.result!,
      outcome: "exhausted",
      fixAttempts: 0,
      summary,
      handoff: check === "failed" ? "- test (command): failed — exited 1" : "Closeout rejected.",
      ruleApprovals: [
        {
          id: "api-contract",
          summary: "No removed field or route.",
          message: "probe exited 1; P1 finding",
          attempt: 1,
          feedback: "api-contract output:\nremoved field Task.title",
        },
      ],
      decision: {
        ...verdict.result!.decision!,
        items: [
          { id: "test", kind: "command", state: check, attempt: 1, message: "exited 1" },
          {
            id: "api-contract",
            kind: "rule",
            state: "failed",
            attempt: 1,
            message: "probe exited 1; P1 finding",
          },
        ],
      },
    },
  };
}

test("a broken approve rule waits for a person on the item page and uses no fix round", async () => {
  const f = await verifyingWithHeldGate({ publicUrl: "https://paws.example" });
  try {
    const item = listWorkItems(f.db)[0]!;
    f.gate.next = ruleBroke(f.gate.runs[0]!.headSha);
    f.release();
    await f.turn;
    await f.flush();

    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    expect(restartReasons(f.db, item.id)).toEqual([]);
    const question = findOpenQuestion(f.db, "ses_1")!;
    expect(getLinkAsk(f.db, question.id)).toMatchObject({
      kind: "rule",
      link: "https://paws.example/status/issues/ENG-7#rule",
    });
    expect(listCloseoutRecoveries(f.db, item.id)[0]?.failedChecks).toEqual(["api-contract"]);
    const asked = f.tracker.questions.at(-1)!;
    expect(asked.options ?? []).toEqual([]);
    expect(asked.body).toContain("Rule api-contract broke: No removed field or route.");
    expect(asked.body).toContain("Decide in Paws: https://paws.example/status/issues/ENG-7#rule");
    expect(asked.body).not.toContain("removed field Task.title");
  } finally {
    await f.close();
  }
}, 90_000);

test("a broken approve rule beside a failed check sends only the check to the agent", async () => {
  const f = await verifyingWithHeldGate({ publicUrl: "https://paws.example" });
  try {
    const item = listWorkItems(f.db)[0]!;
    f.gate.next = ruleBroke(f.gate.runs[0]!.headSha, "failed");
    f.release();
    await f.turn;
    await f.flush();

    expect(getWorkItem(f.db, item.id)?.state).toBe("queued");
    expect(restartReasons(f.db, item.id)).toEqual(["findings"]);
    const resume = listJobs(f.db).find(
      (job) => job.queue === JOB_KIND.resume && job.status === "pending",
    )!;
    const handoff = (resume.payload as { handoff: string }).handoff;
    expect(handoff).toContain("test (command): failed");
    expect(handoff).not.toContain("removed field Task.title");
  } finally {
    await f.close();
  }
}, 90_000);

function restartReasons(db: Database, itemId: string): string[] {
  return db
    .query<{ reason: string }, [string]>(
      "SELECT reason FROM work_item_event WHERE item_id = ? AND kind = 'restart' ORDER BY id",
    )
    .all(itemId)
    .map((row) => row.reason);
}

/** One item whose turn ended and whose Closeout run is held open by the fake gate. */
async function verifyingWithHeldGate(options: { publicUrl?: string; remote?: boolean } = {}) {
  const layout = await repoLayout();
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-7",
      title: "Settings screen",
      description: null,
      subIssues: [],
    },
  ]);
  const clock: Clock = { now: () => Date.now(), mono: () => performance.now() };
  const db = openDatabase(path.join(layout.pawsRoot, "paws.db"));
  migrate(db);
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  const gate = createFakeCloseoutGate();
  let release!: () => void;
  gate.held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let thrown: Error | null = null;
  const run = gate.run;
  gate.run = async (input) => {
    const verdict = await run(input);
    if (thrown) throw thrown;
    return verdict;
  };
  const lines: string[] = [];
  let launches = 0;
  const launch: AgentLaunch = () => {
    launches += 1;
    const scriptPath = path.join(layout.root, `script-${launches}.json`);
    const resultPath = path.join(layout.root, `result-${launches}.json`);
    writeFileSync(
      scriptPath,
      JSON.stringify({
        model: "test-claude-model",
        steps: [{ type: "end", stopReason: "end_turn" }],
      }),
    );
    return {
      command: process.execPath,
      args: [fakeAgent, resultPath, scriptPath],
      env: process.env,
    };
  };
  const github = createFakeGitHub();
  const attach = () =>
    attachOrchestrator({
      db,
      admission: workspaceAdmission(db),
      jobs,
      outbox,
      clock,
      pawsRoot: layout.pawsRoot,
      home: layout.home,
      tracker,
      repositories: [{ owner: "pmdroid", repo: "paws-demo", remoteUrl: layout.bare }],
      githubForRepository: () => ({
        appId: "1",
        installationId: "2",
        privateKeyPem: privateKey as string,
        client: githubClient(layout.bare, github),
      }),
      launch,
      ...(options.remote
        ? { remoteExecution: { agentForItem: () => runAgent, agentForSession: () => runAgent } }
        : {}),
      closeoutGate: () => gate,
      journal: (line) => lines.push(line),
      ...(options.publicUrl ? { publicUrl: options.publicUrl } : {}),
    });
  let orchestrator = attach();
  await orchestrator.onLinearEvent(created());
  db.run("UPDATE work_item SET delegated_by = 'delegator-1'");
  const turn = jobs.tick();
  await attachRunnerLease(db);
  const deadline = Date.now() + 30_000;
  while (gate.runs.length === 0) {
    if (Date.now() > deadline)
      throw new Error(
        JSON.stringify({ items: listWorkItems(db), lines, progress: tracker.progress }),
      );
    await Bun.sleep(20);
  }
  const jobId = listJobs(db).find((job) => job.status === "running")!.id;
  const flush = async () => {
    for (let round = 0; round < 20; round++) {
      const claimed = outbox.tick();
      await outbox.idle();
      if (claimed.length === 0) return;
    }
  };
  return {
    db,
    gate,
    jobId,
    release: () => release(),
    /** The held run throws this instead of returning its verdict. */
    throwFromRun(error: Error | null) {
      thrown = error;
    },
    turn,
    tracker,
    get orchestrator() {
      return orchestrator;
    },
    flush,
    stalls: () => lines.filter((line) => line.includes("in verifying:")),
    async restart() {
      await orchestrator.shutdown();
      orchestrator = attach();
    },
    tickReverify: () => jobs.tick([JOB_KIND.reverify]),
    async tickAll() {
      while ((await jobs.tick()) !== null);
      await flush();
    },
    async close() {
      await orchestrator.shutdown();
      db.close();
      await layout.cleanup();
    },
  };
}

async function attachRunnerLease(db: Database): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const item = listWorkItems(db)[0];
    const run = item?.currentRunId ? getRun(db, item.currentRunId) : null;
    if (run?.status === "active") {
      const now = Date.now();
      const userId = putWorkspaceUser(db, {
        id: "user-1",
        linearUserId: "user-linear",
        name: "Owner",
        email: "owner@example.invalid",
      });
      db.run("INSERT INTO workspace VALUES(?,?,?,?)", ["ws-1", "org-1", "Workspace", now]);
      syncWorkspaceMember(db, {
        workspaceId: "ws-1",
        userId,
        role: "admin",
        active: true,
        teamIds: [],
        now,
      });
      db.run(
        "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
        ["runner-1", "ws-1", userId, "Runner", now, now],
      );
      db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES(?,1)", ["runner-1"]);
      db.run(
        "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES(?,?,?,1,0,?,?,0)",
        [run.id, "runner-1", "ws-1", `cmd-${run.id}`, now + 60_000],
      );
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("implement run did not become active");
}

async function repoLayout() {
  const root = await mkdtemp(path.join(tmpdir(), "paws-closeout-stall-"));
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const pawsRoot = path.join(root, "paws");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(pawsRoot, { recursive: true });
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, seed]);
  await exec("git", ["-C", seed, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", seed, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", seed, "config", "commit.gpgsign", "false"]);
  await mkdir(path.join(seed, ".agents"), { recursive: true });
  await writeFile(path.join(seed, ".agents", "closeout.yaml"), POLICY);
  await writeFile(path.join(seed, "README.md"), "paws demo\n");
  await exec("git", ["-C", seed, "add", "."]);
  await exec("git", ["-C", seed, "commit", "-m", "init"]);
  await exec("git", ["-C", seed, "push", "origin", "HEAD:main"]);
  return { root, bare, pawsRoot, home, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function created(): AcceptedLinearEvent {
  return {
    dedupeKey: "created:issue",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "ses_1",
    issueId: "issue",
    activityId: null,
    actorId: null,
    body: null,
    signal: null,
    updatedAtMs: Date.now(),
    payload: "{}",
  };
}
