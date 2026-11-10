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
  getLinearSessionGeneration,
  getLinkAsk,
  getRun,
  getWorkItem,
  listCloseoutRecoveries,
  listJobs,
  listPendingLinearTurns,
  listWorkItems,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import {
  createFakeCloseoutGate,
  type CloseoutVerdict,
  type CandidateIdentity,
} from "../src/closeout";
import { createFakeGitHub } from "../src/github";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, type AgentLaunch, type LinearConversations } from "../src/loop";
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

const REPLY = "Also cover the empty state.";
const WAITS = "Got it. I'll pick this up once verification finishes.";

function reply(body: string): AcceptedLinearEvent {
  return {
    dedupeKey: `activity:${body}`,
    deliveryId: null,
    source: "webhook",
    action: "prompted",
    sessionId: "ses_1",
    issueId: "issue",
    activityId: `act-${body}`,
    actorId: "human-1",
    body,
    signal: null,
    updatedAtMs: Date.now() + 1_000,
    payload: "{}",
  };
}

function itemEvents(db: Database, itemId: string): string[] {
  return db
    .query<{ event: string }, [string]>(
      "SELECT event FROM work_item_event WHERE item_id = ? ORDER BY id",
    )
    .all(itemId)
    .map((row) => row.event);
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}

test("a reply during Closeout waits for the verdict instead of aborting it", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    const generation = getLinearSessionGeneration(f.db, "ses_1");
    await f.orchestrator.onLinearEvent(reply(REPLY));
    await f.flush();

    expect(getWorkItem(f.db, item.id)?.state).toBe("verifying");
    expect(getLinearSessionGeneration(f.db, "ses_1")).toBe(generation);
    expect(listPendingLinearTurns(f.db, "ses_1")).toMatchObject([
      { body: REPLY, announcedGeneration: null },
    ]);
    const bodies = f.tracker.progress.map((update) => update.body);
    expect(bodies.filter((body) => body === WAITS)).toHaveLength(1);
    expect(bodies).not.toContain("Received your update.");
    await f.orchestrator.onLinearEvent(reply(REPLY));
    await f.flush();
    expect(f.tracker.progress.filter((update) => update.body === WAITS)).toHaveLength(1);
    expect(getWorkItem(f.db, item.id)?.state).toBe("verifying");

    f.release();
    await f.turn;
    expect(itemEvents(f.db, item.id)).toContain("closeout_accepted");
    expect(getWorkItem(f.db, item.id)?.acceptedHead).toBe(f.gate.runs[0]!.headSha);
    expect(restartReasons(f.db, item.id)).toEqual(["follow_up"]);
    expect(getWorkItem(f.db, item.id)?.state).toBe("queued");
    const resumes = listJobs(f.db).filter(
      (job) => job.queue === JOB_KIND.resume && job.status === "pending",
    );
    expect(resumes).toHaveLength(1);
    expect((resumes[0]!.payload as { handoff: string }).handoff).toContain(REPLY);
    expect(f.stalls()).toEqual([]);
  } finally {
    f.release();
    await f.turn;
    await f.close();
  }
}, 90_000);

for (const template of [null, "Issue: {{issue.identifier}}: {{issue.title}}"]) {
  test(`a reply during a rejecting Closeout rides the findings restart into the next prompt once (${template === null ? "built-in brief" : "brief without user updates"})`, async () => {
    const f = await verifyingWithHeldGate();
    try {
      const item = listWorkItems(f.db)[0]!;
      if (template !== null)
        writeFileSync(
          path.join(f.pawsRoot, "config.toml"),
          `[brief]\ntemplate = ${JSON.stringify(template)}\n`,
        );
      await f.orchestrator.onLinearEvent(reply(REPLY));
      f.gate.next = fixFailed(f.gate.runs[0]!.headSha);
      f.release();
      await f.turn;

      expect(restartReasons(f.db, item.id)).toEqual(["findings"]);
      expect(getWorkItem(f.db, item.id)?.state).toBe("queued");
      expect(listPendingLinearTurns(f.db, "ses_1").map((turn) => turn.body)).toEqual([REPLY]);
      expect(f.stalls()).toEqual([]);

      f.gate.next = { decision: "accepted", exhausted: false, summary: "fake accepted" };
      f.db.run("UPDATE runner_work SET ended_at=?, teardown_confirmed_at=?", [
        Date.now(),
        Date.now(),
      ]);
      await f.orchestrator.reconcileExecution();
      await f.tickResume();
      const fixes = f.prompts.filter((prompt) => prompt.includes("Fix the P1 review finding."));
      expect(fixes).toHaveLength(1);
      expect(occurrences(fixes[0]!, REPLY)).toBe(1);
      expect(fixes[0]).toContain(`User update:\n${REPLY}`);
      if (template !== null) expect(fixes[0]).toContain("Issue: ENG-7: Settings screen");
      expect(listPendingLinearTurns(f.db, "ses_1")).toEqual([]);
      expect(restartReasons(f.db, item.id)).toEqual(["findings"]);
    } finally {
      f.release();
      await f.turn;
      await f.close();
    }
  }, 90_000);
}

test("a reply during Closeout that ends in a question waits for its answer", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    await f.orchestrator.onLinearEvent(reply(REPLY));
    const verdict = fixFailed(f.gate.runs[0]!.headSha);
    f.gate.next = {
      ...verdict,
      decision: "rejected",
      exhausted: true,
      result: {
        ...verdict.result!,
        outcome: "exhausted",
        decision: {
          ...verdict.result!.decision!,
          items: [{ id: "test", kind: "command", state: "exhausted", message: "still failing" }],
        },
      },
    };
    f.release();
    await f.turn;

    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    expect(findOpenQuestion(f.db, "ses_1")?.kind).toBe("closeout-help");
    expect(restartReasons(f.db, item.id)).toEqual([]);
    expect(listPendingLinearTurns(f.db, "ses_1").map((turn) => turn.body)).toEqual([REPLY]);
  } finally {
    f.release();
    await f.turn;
    await f.close();
  }
}, 90_000);

test("a reply during a Closeout run that fails restarts the failed item with it", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    await f.orchestrator.onLinearEvent(reply(REPLY));
    f.throwFromRun(new Error("fixture Closeout transport lost"));
    f.release();
    await f.turn;

    expect(itemEvents(f.db, item.id)).toContain("closeout_infra_failed");
    expect(restartReasons(f.db, item.id)).toEqual(["follow_up"]);
    expect(getWorkItem(f.db, item.id)?.state).toBe("queued");
    const resume = listJobs(f.db).find(
      (job) => job.queue === JOB_KIND.resume && job.status === "pending",
    );
    expect((resume!.payload as { handoff: string }).handoff).toContain(REPLY);
  } finally {
    f.release();
    await f.turn;
    await f.close();
  }
}, 90_000);

test("a reply waits through a Closeout retry and goes on after its verdict", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    await f.orchestrator.onLinearEvent(reply(REPLY));
    f.throwFromRun(new DOMException("The operation was aborted.", "AbortError"));
    const interrupted = f.orchestrator.interruptLinearSession("ses_1");
    f.release();
    await f.turn;
    await interrupted;

    expect(getWorkItem(f.db, item.id)?.state).toBe("verifying");
    const [retry, ...rest] = closeoutFaultJobs(f.db);
    expect(rest).toEqual([]);
    expect(retry?.status).toBe("pending");
    expect(restartReasons(f.db, item.id)).toEqual([]);
    expect(listPendingLinearTurns(f.db, "ses_1").map((turn) => turn.body)).toEqual([REPLY]);

    f.throwFromRun(null);
    f.db.run("UPDATE job SET run_at = 0 WHERE id = ?", [retry!.id]);
    await f.tickReverify();
    expect(itemEvents(f.db, item.id)).toContain("closeout_accepted");
    expect(restartReasons(f.db, item.id)).toEqual(["follow_up"]);
    expect(getWorkItem(f.db, item.id)?.state).toBe("queued");
  } finally {
    f.release();
    await f.turn;
    await f.close();
  }
}, 90_000);

async function heldForRetry(f: Awaited<ReturnType<typeof verifyingWithHeldGate>>) {
  f.throwFromRun(new DOMException("The operation was aborted.", "AbortError"));
  const interrupted = f.orchestrator.interruptLinearSession("ses_1");
  f.release();
  await f.turn;
  await interrupted;
  const [retry] = closeoutFaultJobs(f.db);
  f.throwFromRun(null);
  f.db.run("UPDATE job SET run_at = 0 WHERE id = ?", [retry!.id]);
  return retry!;
}

test("a reply that waits through a Closeout retry failing on its last attempt restarts the failed item with it", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    await f.orchestrator.onLinearEvent(reply(REPLY));
    const retry = await heldForRetry(f);
    expect(listPendingLinearTurns(f.db, "ses_1").map((turn) => turn.body)).toEqual([REPLY]);

    f.throwFromRun(new Error("fixture Closeout transport lost"));
    f.db.run("UPDATE job SET attempts = max_attempts - 1 WHERE id = ?", [retry.id]);
    await f.tickReverify();

    expect(itemEvents(f.db, item.id)).toContain("closeout_infra_failed");
    expect(restartReasons(f.db, item.id)).toEqual(["follow_up"]);
    expect(getWorkItem(f.db, item.id)?.state).toBe("queued");
    const resume = listJobs(f.db).find(
      (job) => job.queue === JOB_KIND.resume && job.status === "pending",
    );
    expect((resume!.payload as { handoff: string }).handoff).toContain(REPLY);
  } finally {
    f.release();
    await f.turn;
    await f.close();
  }
}, 90_000);

test("a reply during a re-verification's Closeout waits for its verdict and then goes on", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    await heldForRetry(f);
    f.hold();
    const reverifying = f.tickReverify();
    const deadline = Date.now() + 30_000;
    while (f.gate.runs.length < 2 && Date.now() < deadline) await Bun.sleep(20);
    expect(f.gate.runs).toHaveLength(2);
    const generation = getLinearSessionGeneration(f.db, "ses_1");

    await f.orchestrator.onLinearEvent(reply(REPLY));
    await f.flush();
    expect(getWorkItem(f.db, item.id)?.state).toBe("verifying");
    expect(getLinearSessionGeneration(f.db, "ses_1")).toBe(generation);
    expect(f.tracker.progress.filter((update) => update.body === WAITS)).toHaveLength(1);
    expect(listPendingLinearTurns(f.db, "ses_1")).toMatchObject([
      { body: REPLY, announcedGeneration: null },
    ]);

    f.release();
    await reverifying;
    expect(itemEvents(f.db, item.id)).toContain("closeout_accepted");
    expect(restartReasons(f.db, item.id)).toEqual(["follow_up"]);
    expect(getWorkItem(f.db, item.id)?.state).toBe("queued");
  } finally {
    f.release();
    await f.turn;
    await f.close();
  }
}, 90_000);

test("an accepted verdict hands a reply that waited for it to a conversation helper", async () => {
  const f = await verifyingWithHeldGate({ conversations: true });
  try {
    const item = listWorkItems(f.db)[0]!;
    await f.orchestrator.onLinearEvent(reply(REPLY));
    f.release();
    await f.turn;

    expect(itemEvents(f.db, item.id)).toContain("closeout_accepted");
    expect(getWorkItem(f.db, item.id)?.state).toBe("merge_queue");
    expect(restartReasons(f.db, item.id)).toEqual([]);
    const comments = listJobs(f.db).filter(
      (job) => job.queue === JOB_KIND.linearComments && job.status === "pending",
    );
    expect(comments).toHaveLength(1);
    f.db.run("UPDATE job SET run_at = 0 WHERE id = ?", [comments[0]!.id]);
    await f.jobs.tick([JOB_KIND.linearComments]);
    expect(f.helpers.map((helper) => [helper.itemId, helper.prompt])).toEqual([[item.id, REPLY]]);
    expect(listPendingLinearTurns(f.db, "ses_1")).toEqual([]);
    expect(restartReasons(f.db, item.id)).toEqual([]);
  } finally {
    f.release();
    await f.turn;
    await f.close();
  }
}, 90_000);

test("a held reply whose delivery after the verdict failed goes on from its job", async () => {
  const f = await verifyingWithHeldGate({ conversations: true });
  try {
    const item = listWorkItems(f.db)[0]!;
    await f.orchestrator.onLinearEvent(reply(REPLY));
    const [held] = listJobs(f.db).filter((job) => job.queue === JOB_KIND.heldReply);
    expect(held).toMatchObject({ status: "pending", payload: { heldReplyFor: "ses_1" } });

    f.db.run("UPDATE job SET run_at = 0 WHERE id = ?", [held!.id]);
    await f.jobs.tick([JOB_KIND.heldReply]);
    const waiting = listJobs(f.db).find((job) => job.id === held!.id)!;
    expect(waiting.status).toBe("pending");
    expect(waiting.runAt).toBeGreaterThan(Date.now());
    expect(listPendingLinearTurns(f.db, "ses_1").map((turn) => turn.body)).toEqual([REPLY]);

    f.conversationsDown(true);
    f.release();
    await f.turn;
    expect(itemEvents(f.db, item.id)).toContain("closeout_accepted");
    expect(getWorkItem(f.db, item.id)?.state).toBe("merge_queue");
    expect(listPendingLinearTurns(f.db, "ses_1").map((turn) => turn.body)).toEqual([REPLY]);
    expect(
      listJobs(f.db).filter(
        (job) => job.queue === JOB_KIND.linearComments && job.status === "pending",
      ),
    ).toEqual([]);

    f.conversationsDown(false);
    await f.restart();
    f.db.run("UPDATE job SET run_at = 0 WHERE id = ?", [held!.id]);
    await f.jobs.tick([JOB_KIND.heldReply]);
    expect(listJobs(f.db).find((job) => job.id === held!.id)?.status).toBe("done");
    const comments = listJobs(f.db).filter(
      (job) => job.queue === JOB_KIND.linearComments && job.status === "pending",
    );
    expect(comments).toHaveLength(1);
    f.db.run("UPDATE job SET run_at = 0 WHERE id = ?", [comments[0]!.id]);
    await f.jobs.tick([JOB_KIND.linearComments]);
    expect(f.helpers.map((helper) => helper.prompt)).toEqual([REPLY]);
    expect(listPendingLinearTurns(f.db, "ses_1")).toEqual([]);
  } finally {
    f.release();
    await f.turn;
    await f.close();
  }
}, 90_000);

function closeoutFaultJobs(db: Database) {
  return listJobs(db).filter(
    (job) =>
      job.queue === JOB_KIND.reverify &&
      (job.payload as { reason?: unknown }).reason === "closeout_fault",
  );
}

test("a job that ends without a Closeout result re-verifies the same head after a minute without asking", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    const head = f.gate.runs[0]!.headSha;
    // The aborted Closeout run throws instead of returning a verdict.
    f.throwFromRun(new DOMException("The operation was aborted.", "AbortError"));
    const interrupted = f.orchestrator.interruptLinearSession("ses_1");
    const before = Date.now();
    f.release();
    await f.turn;
    await interrupted;
    await f.flush();

    expect(f.stalls()).toEqual([
      `job ${f.jobId} ${JOB_KIND.start} left item ${item.id} (ENG-7) in verifying: the job ended without a Closeout result`,
    ]);
    expect(getWorkItem(f.db, item.id)?.state).toBe("verifying");
    expect(findOpenQuestion(f.db, "ses_1")).toBeNull();
    expect(listCloseoutRecoveries(f.db, item.id)).toHaveLength(0);
    const [retry, ...rest] = closeoutFaultJobs(f.db);
    expect(rest).toEqual([]);
    expect(retry).toMatchObject({
      status: "pending",
      payload: {
        itemId: item.id,
        closeoutFaults: { head, reasons: ["the job ended without a Closeout result"] },
      },
    });
    expect(retry!.runAt - before).toBeGreaterThanOrEqual(60_000);
    expect(retry!.runAt - Date.now()).toBeLessThanOrEqual(60_000);
    expect(f.tracker.progress.map((update) => update.body)).toContain(
      "Closeout stopped without a result; retrying in 1 min.",
    );
    expect(restartReasons(f.db, item.id)).toEqual([]);
  } finally {
    await f.close();
  }
}, 90_000);

test("repeated Closeout faults on one head back off further and the fourth asks once", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    f.throwFromRun(new DOMException("The operation was aborted.", "AbortError"));
    f.db.run("UPDATE job SET locked_by = 'lost' WHERE id = ?", [f.jobId]);
    f.release();
    await f.turn;
    f.db.run("UPDATE job SET status = 'done', locked_by = NULL WHERE id = ?", [f.jobId]);
    // Every later re-verify ends without a Closeout result.
    (
      f.orchestrator as unknown as { candidateForItem: () => Promise<CandidateIdentity | null> }
    ).candidateForItem = async () => null;
    enqueueJob(f.db, { queue: JOB_KIND.resume, payload: { itemId: item.id }, now: Date.now() });
    await f.tickAll();

    const delays: number[] = [];
    for (let fault = 1; fault <= 3; fault++) {
      const jobs = closeoutFaultJobs(f.db);
      expect(jobs).toHaveLength(fault);
      const pending = jobs.at(-1)!;
      expect(pending.status).toBe("pending");
      expect(
        (pending.payload as { closeoutFaults: { reasons: string[] } }).closeoutFaults.reasons,
      ).toHaveLength(fault);
      delays.push(pending.runAt - pending.createdAt);
      expect(findOpenQuestion(f.db, "ses_1")).toBeNull();
      f.db.run("UPDATE job SET run_at = 0 WHERE id = ?", [pending.id]);
      await f.tickReverify();
      await f.flush();
    }
    expect(delays).toEqual([60_000, 5 * 60_000, 15 * 60_000]);
    expect(closeoutFaultJobs(f.db)).toHaveLength(3);
    expect(getWorkItem(f.db, item.id)?.state).toBe("awaiting_input");
    expect(findOpenQuestion(f.db, "ses_1")?.kind).toBe("closeout-help");
    const asks = f.tracker.questions.filter((question) =>
      question.body.includes("Verification stopped without moving the task on"),
    );
    expect(asks).toHaveLength(1);
    expect(asks[0]!.body).toContain("Closeout stopped without a result 4 times on this head:");
    expect(restartReasons(f.db, item.id)).toEqual([]);
  } finally {
    await f.close();
  }
}, 90_000);

test("a successful re-verify after one Closeout fault reaches the merge queue and clears the count", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    f.throwFromRun(new DOMException("The operation was aborted.", "AbortError"));
    const interrupted = f.orchestrator.interruptLinearSession("ses_1");
    f.release();
    await f.turn;
    await interrupted;
    f.throwFromRun(null);
    const [retry] = closeoutFaultJobs(f.db);
    f.db.run("UPDATE job SET run_at = 0 WHERE id = ?", [retry!.id]);
    await f.tickReverify();

    expect(listJobs(f.db).find((job) => job.id === retry!.id)?.status).toBe("done");
    expect(getWorkItem(f.db, item.id)?.state).toBe("merge_queue");
    expect(findOpenQuestion(f.db, "ses_1")).toBeNull();
    expect(
      listJobs(f.db).filter(
        (job) => job.status === "pending" && "closeoutFaults" in (job.payload as object),
      ),
    ).toEqual([]);
  } finally {
    await f.close();
  }
}, 90_000);

test("a reverify waits beside the turn's own Closeout and survives its state change", async () => {
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
    expect(f.gate.runs).toHaveLength(2);
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
      expect(f.gate.decisions).toHaveLength(1);
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

for (const scenario of ["imported", "retry", "terminal", "mismatch", "question", "reader"] as const)
  test(`a delivered runner result survives lease grace: ${scenario}`, async () => {
    const importResult = scenario === "imported";
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
      if (scenario === "mismatch") {
        f.db.run("UPDATE work_item SET state='merge_queue' WHERE id=?", [item.id]);
        const port = f.orchestrator as unknown as {
          candidateForItem: (input: typeof item) => Promise<CandidateIdentity | null>;
        };
        const original = port.candidateForItem.bind(f.orchestrator);
        port.candidateForItem = async () => ({
          ...(await original(item))!,
          model: "different-model",
        });
      }
      let readerBusy = scenario === "reader";
      const runtime = f.orchestrator as unknown as {
        options: { remoteExecution: { runInProgress?: (id: string) => Promise<boolean> } };
      };
      runtime.options.remoteExecution.runInProgress = async (id) => id === runId && readerBusy;
      let imported = false;
      const verify = f.gate.run;
      f.gate.run = async (input) => {
        expect(getWorkItem(f.db, item.id)?.currentRunId).toBe(runId);
        expect(getRun(f.db, runId)?.status).toBe("active");
        expect(
          f.db.query("SELECT 1 FROM runner_work WHERE run_id=? AND ended_at IS NULL").get(runId),
        ).not.toBeNull();
        if (scenario === "question") {
          f.db.run("UPDATE work_item SET state='awaiting_input' WHERE id=?", [item.id]);
          throw new DOMException("fixture question", "AbortError");
        }
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
        maxAttempts: scenario === "terminal" ? 1 : 2,
      });
      await f.tickReverify();
      if (scenario === "reader") {
        expect(f.gate.runs).toHaveLength(1);
        expect(getRun(f.db, runId)?.status).toBe("active");
        expect(listJobs(f.db).find((j) => j.id === jobId)?.status).toBe("pending");
        readerBusy = false;
        f.db.run("UPDATE job SET run_at=0 WHERE id=?", [jobId]);
        await f.tickReverify();
      }
      expect(imported).toBe(importResult);
      const current = getWorkItem(f.db, item.id)!;
      if (scenario === "terminal") {
        expect(current.state).toBe("failed");
        expect(getRun(f.db, runId)?.status).toBe("lost");
      } else if (scenario === "question") {
        expect(current.state).toBe("awaiting_input");
        expect(getRun(f.db, runId)?.status).toBe("active");
      } else {
        expect(listJobs(f.db).find((job) => job.id === jobId)?.status).toBe(
          importResult ? "done" : "pending",
        );
        expect(current).toMatchObject({
          state: importResult || scenario === "mismatch" ? "merge_queue" : "verifying",
          currentRunId: runId,
        });
        expect(getRun(f.db, runId)?.status).toBe(importResult ? "ended" : "active");
      }
      expect(
        f.db.query("SELECT 1 FROM runner_work WHERE run_id=? AND ended_at IS NULL").get(runId) !==
          null,
      ).toBe(!importResult && scenario !== "terminal");
    } finally {
      f.release();
      await f.turn;
      await f.close();
    }
  }, 90_000);

test("a prolonged sibling ownership hold cannot interrupt its healthy owner", async () => {
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
      status: "pending",
      lastError: null,
    });
    expect(getWorkItem(f.db, item.id)?.state).toBe("merge_queue");
    expect(findOpenQuestion(f.db, "ses_1")).toBeNull();
    expect(f.gate.runs).toHaveLength(1);
  } finally {
    f.release();
    await f.turn;
    await f.close();
  }
}, 90_000);

test("a long live Closeout finishes without a waiter opening a blocked question", async () => {
  const f = await verifyingWithHeldGate({ remote: true });
  try {
    const item = listWorkItems(f.db)[0]!;
    const jobId = enqueueJob(f.db, {
      queue: JOB_KIND.reverify,
      now: Date.now(),
      payload: { itemId: item.id, decide: true, verificationWaitSince: Date.now() - 30 * 60_000 },
    });
    f.db.run("UPDATE job SET queue='held-test-turn' WHERE id=?", [f.jobId]);
    await f.tickReverify();
    expect(getWorkItem(f.db, item.id)?.state).toBe("verifying");
    expect(findOpenQuestion(f.db, "ses_1")).toBeNull();
    expect(listJobs(f.db).find((j) => j.id === jobId)?.status).toBe("pending");
    f.release();
    await f.turn;
    expect(getWorkItem(f.db, item.id)?.state).toBe("merge_queue");
  } finally {
    f.release();
    await f.turn;
    await f.close();
  }
}, 90_000);

test("ownership acquired during preparation preserves the original wait timer", async () => {
  const f = await verifyingWithHeldGate({ remote: true });
  try {
    f.release();
    await f.turn;
    await f.restart();
    const item = listWorkItems(f.db)[0]!;
    f.db.run("UPDATE run SET status='active' WHERE id=?", [item.currentRunId]);
    const port = f.orchestrator as unknown as {
      live: Map<string, { itemId: string }>;
      candidateForItem: (input: typeof item) => Promise<CandidateIdentity | null>;
    };
    const candidate = port.candidateForItem.bind(f.orchestrator);
    port.candidateForItem = async (input) => {
      const result = await candidate(input);
      port.live.set(item.currentRunId!, { itemId: item.id });
      return result;
    };
    const since = Date.now() - 19 * 60_000;
    const jobId = enqueueJob(f.db, {
      queue: JOB_KIND.reverify,
      now: Date.now(),
      payload: { itemId: item.id, verificationWaitSince: since },
    });
    await f.tickReverify();
    port.live.delete(item.currentRunId!);
    expect(listJobs(f.db).find((j) => j.id === jobId)).toMatchObject({
      status: "pending",
      payload: { verificationWaitSince: since },
      attempts: 0,
    });
    expect(f.gate.runs).toHaveLength(1);
    expect(findOpenQuestion(f.db, "ses_1")).toBeNull();
  } finally {
    f.release();
    await f.turn;
    await f.close();
  }
}, 90_000);

for (const state of [
  "running",
  "queued",
  "paused",
  "recovering",
  "awaiting_input",
  "failed",
  "cancelled",
  "completed",
  "merged",
  "cancel-requested",
] as const)
  test(`a stale reverify cannot park or ask on ${state}`, async () => {
    const f = await verifyingWithHeldGate({ remote: true });
    try {
      f.release();
      await f.turn;
      await f.restart();
      const item = listWorkItems(f.db)[0]!;
      f.db.run("UPDATE work_item SET state=?,cancel_requested=? WHERE id=?", [
        state === "cancel-requested" ? "verifying" : state,
        state === "cancel-requested" ? 1 : 0,
        item.id,
      ]);
      const contexts = (f.orchestrator as unknown as { jobContexts: Map<string, unknown> })
        .jobContexts;
      contexts.set(item.id, { isCurrent: () => true });
      const jobId = enqueueJob(f.db, {
        queue: JOB_KIND.reverify,
        payload: { itemId: item.id, verificationWaitSince: Date.now() - 30 * 60_000 },
        now: Date.now(),
      });
      await f.tickReverify();
      contexts.delete(item.id);
      expect(listJobs(f.db).find((job) => job.id === jobId)?.status).toBe("done");
      expect(findOpenQuestion(f.db, "ses_1")).toBeNull();
      expect(getWorkItem(f.db, item.id)?.state).toBe(
        state === "cancel-requested" ? "verifying" : state,
      );
      expect(f.gate.runs).toHaveLength(1);
    } finally {
      f.release();
      await f.turn;
      await f.close();
    }
  }, 90_000);

test("an ownership timer is cleared before work and a later hold starts a fresh timer", async () => {
  const f = await verifyingWithHeldGate({ remote: true });
  try {
    f.release();
    await f.turn;
    await f.restart();
    const item = listWorkItems(f.db)[0]!;
    const contexts = (f.orchestrator as unknown as { jobContexts: Map<string, unknown> })
      .jobContexts;
    const jobId = enqueueJob(f.db, {
      queue: JOB_KIND.reverify,
      payload: { itemId: item.id, verificationWaitSince: Date.now() - 19 * 60_000 },
      now: Date.now(),
    });
    let entered = false;
    f.gate.run = async () => {
      entered = true;
      expect(listJobs(f.db).find((job) => job.id === jobId)?.payload).not.toHaveProperty(
        "verificationWaitSince",
      );
      throw new Error("fixture transport pause");
    };
    await f.tickReverify();
    expect(entered).toBe(true);
    expect(listJobs(f.db).find((job) => job.id === jobId)?.status).toBe("pending");
    contexts.set(item.id, { isCurrent: () => true });
    f.db.run("UPDATE job SET run_at=0 WHERE id=?", [jobId]);
    await f.tickReverify();
    contexts.delete(item.id);
    const waiting = listJobs(f.db).find((job) => job.id === jobId)!;
    expect(waiting.status).toBe("pending");
    expect(
      (waiting.payload as { verificationWaitSince: number }).verificationWaitSince,
    ).toBeGreaterThan(Date.now() - 10_000);
    expect(findOpenQuestion(f.db, "ses_1")).toBeNull();
  } finally {
    f.release();
    await f.turn;
    await f.close();
  }
}, 90_000);

for (const problem of ["no-session", "notification-error"] as const)
  test(`an ownership timeout with ${problem} has a terminal outcome`, async () => {
    const f = await verifyingWithHeldGate({ remote: true });
    try {
      f.release();
      await f.turn;
      await f.restart();
      const item = listWorkItems(f.db)[0]!;
      const internals = f.orchestrator as unknown as {
        jobContexts: Map<string, unknown>;
        activitySession: () => string | null;
        askCloseoutHelp: () => Promise<void>;
      };
      f.db.run("UPDATE run SET status='active' WHERE id=?", [item.currentRunId]);
      f.db.run("UPDATE runner_work SET ended_at=NULL, lease_until=? WHERE run_id=?", [
        Date.now() + 60_000,
        item.currentRunId,
      ]);
      if (problem === "no-session") internals.activitySession = () => null;
      else
        internals.askCloseoutHelp = async () => {
          throw new Error("fixture notification unavailable");
        };
      const jobId = enqueueJob(f.db, {
        queue: JOB_KIND.reverify,
        maxAttempts: 1,
        payload: { itemId: item.id, verificationWaitSince: Date.now() - 30 * 60_000 },
        now: Date.now(),
      });
      await f.tickReverify();
      internals.jobContexts.delete(item.id);
      expect(getWorkItem(f.db, item.id)?.state).toBe("failed");
      expect(["done", "cancelled"]).toContain(
        listJobs(f.db).find((job) => job.id === jobId)?.status ?? "",
      );
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
        // A rebased merge-queue head still needs a new round even with a verifying checkpoint.
        f.db.run(
          "UPDATE work_item SET checkpoint=json_set(checkpoint,'$.phase','verifying') WHERE id=?",
          [item.id],
        );
        const port = f.orchestrator as unknown as {
          startCloseoutRound: (item: unknown, head: string) => Promise<void>;
        };
        const startRound = port.startCloseoutRound.bind(f.orchestrator);
        let rounds = 0;
        port.startCloseoutRound = async (owned, head) => {
          rounds++;
          await startRound(owned, head);
        };
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
          expect(rounds).toBe(state === "merge_queue" ? 1 : 0);
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
      link: "https://paws.example/dashboard/issues/ENG-7#review-rounds",
      rounds: { limit: 4, handoff: "Fix the P1 review finding." },
    });
    // The recovery row keeps the retry baseline a Rethink or Keep going grants.
    expect(listCloseoutRecoveries(f.db, item.id).map((entry) => entry.questionId)).toEqual([
      question.id,
    ]);
    const asked = f.tracker.questions.at(-1)!;
    expect(asked.options ?? []).toEqual([]);
    expect(asked.body).toContain(
      "Decide in Paws: https://paws.example/dashboard/issues/ENG-7#review-rounds",
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
      link: "https://paws.example/dashboard/issues/ENG-7#rule",
    });
    expect(listCloseoutRecoveries(f.db, item.id)[0]?.failedChecks).toEqual(["api-contract"]);
    const asked = f.tracker.questions.at(-1)!;
    expect(asked.options ?? []).toEqual([]);
    expect(asked.body).toContain("Rule api-contract broke: No removed field or route.");
    expect(asked.body).toContain(
      "Decide in Paws: https://paws.example/dashboard/issues/ENG-7#rule",
    );
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
async function verifyingWithHeldGate(
  options: { publicUrl?: string; remote?: boolean; conversations?: boolean } = {},
) {
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
  const hold = () => {
    gate.held = new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  hold();
  const helpers: { itemId: string; sessionId: string; prompt: string }[] = [];
  const conversations: LinearConversations = {
    lane: () => "free",
    start: (itemId, sessionId, prompt) => {
      helpers.push({ itemId, sessionId, prompt });
      return true;
    },
    open: () => [],
    finish: () => undefined,
  };
  let conversationsDown = false;
  let thrown: Error | null = null;
  const run = gate.run;
  gate.run = async (input) => {
    const verdict = await run(input);
    if (thrown) throw thrown;
    return verdict;
  };
  const lines: string[] = [];
  const prompts: string[] = [];
  let launches = 0;
  const launch: AgentLaunch = (input) => {
    prompts.push(input.prompt);
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
      ...(options.conversations
        ? {
            linearComments: { appUserId: null, agents: [] },
            conversations: async () => {
              if (conversationsDown) throw new Error("fixture runner unreachable");
              return conversations;
            },
          }
        : {}),
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
      const claimed = await outbox.tick();
      await outbox.idle();
      if (claimed.length === 0) return;
    }
  };
  return {
    db,
    gate,
    jobId,
    release: () => release(),
    hold,
    helpers,
    jobs,
    conversationsDown(down: boolean) {
      conversationsDown = down;
    },
    /** The held run throws this instead of returning its verdict. */
    throwFromRun(error: Error | null) {
      thrown = error;
    },
    turn,
    tracker,
    prompts,
    pawsRoot: layout.pawsRoot,
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
    tickResume: () => jobs.tick([JOB_KIND.resume]),
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

test("Retry Closeout on a policy that did not load verifies the same head into the merge queue", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = listWorkItems(f.db)[0]!;
    const runId = item.currentRunId;
    f.gate.next = {
      decision: "blocked",
      exhausted: false,
      summary: "Closeout: blocked\nMessage: .agents/closeout.yaml could not be read",
    };
    f.release();
    await f.turn;
    await f.flush();
    const question = findOpenQuestion(f.db, "ses_1")!;
    expect(question).toMatchObject({ kind: "closeout-help", options: ["Retry Closeout"] });

    f.gate.next = { decision: "accepted", exhausted: false, summary: "Closeout: accepted" };
    expect(
      await f.orchestrator.answerFromPaws({
        questionId: question.id,
        answer: "Retry Closeout",
        answeredBy: "delegator-1",
        answeredByName: "Delegator",
      }),
    ).toBe("answered");
    expect(getWorkItem(f.db, item.id)?.state).toBe("verifying");
    expect(
      listJobs(f.db)
        .filter((job) => job.queue === JOB_KIND.reverify)
        .map((job) => job.jobKey),
    ).toEqual([`retry-closeout:${question.id}`]);
    await f.tickReverify();

    expect(getWorkItem(f.db, item.id)).toMatchObject({ state: "merge_queue", currentRunId: runId });
    expect(f.gate.runs.map((run) => run.headSha)).toEqual([
      f.gate.runs[0]!.headSha,
      f.gate.runs[0]!.headSha,
    ]);
    expect(restartReasons(f.db, item.id)).toEqual([]);
  } finally {
    await f.close();
  }
}, 90_000);
