import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
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
  syncSteps,
  type Db,
  type Q,
} from "../src/db";
import {
  createFakeCloseoutGate,
  type CloseoutVerdict,
  type CandidateIdentity,
} from "../src/closeout";
import { createFakeGitHub } from "../src/github";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator, type AgentLaunch } from "../src/loop";
import { findOpenQuestion } from "../src/questions";
import { githubClient } from "./e2e-harness";
import { seed } from "./dialects";
import { workspaceAdmission } from "./fake-workspace";
import { tempStore } from "./pglite";
import { seedRunnerLease } from "./runner-lease-seed";

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
    const item = (await listWorkItems(f.db))[0]!;
    expect(item.state).toBe("verifying");
    // As for PAS-629, an item.start job for the same item waits while this job verifies it.
    const second = await enqueueJob(f.db, {
      queue: JOB_KIND.start,
      payload: { itemId: item.id },
      now: Date.now(),
    });
    // Something aborts the live operation without moving the item out of verifying.
    const interrupted = (await f.interrupt()).done;
    f.gate.next = fixFailed(f.gate.runs[0]!.headSha);
    f.release();
    await f.turn;
    await interrupted;

    expect((await getWorkItem(f.db, item.id))?.state).toBe("queued");
    expect(await restartReasons(f.db, item.id)).toEqual(["findings"]);
    const jobs = await listJobs(f.db);
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

async function closeoutFaultJobs(db: Db) {
  return (await listJobs(db)).filter(
    (job) =>
      job.queue === JOB_KIND.reverify &&
      (job.payload as { reason?: unknown }).reason === "closeout_fault",
  );
}

test("a job that ends without a Closeout result re-verifies the same head after a minute without asking", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = (await listWorkItems(f.db))[0]!;
    const head = f.gate.runs[0]!.headSha;
    // The aborted Closeout run throws instead of returning a verdict.
    f.throwFromRun(new DOMException("The operation was aborted.", "AbortError"));
    const interrupted = (await f.interrupt()).done;
    const before = Date.now();
    f.release();
    await f.turn;
    await interrupted;
    await f.flush();

    expect(f.stalls()).toEqual([
      `job ${f.jobId} ${JOB_KIND.start} left item ${item.id} (ENG-7) in verifying: the job ended without a Closeout result`,
    ]);
    expect((await getWorkItem(f.db, item.id))?.state).toBe("verifying");
    expect(await findOpenQuestion(f.db, "ses_1")).toBeNull();
    expect(await listCloseoutRecoveries(f.db, item.id)).toHaveLength(0);
    const [retry, ...rest] = await closeoutFaultJobs(f.db);
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
    expect(await restartReasons(f.db, item.id)).toEqual([]);
  } finally {
    await f.close();
  }
}, 90_000);

test("repeated Closeout faults on one head back off further and the fourth asks once", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = (await listWorkItems(f.db))[0]!;
    f.throwFromRun(new DOMException("The operation was aborted.", "AbortError"));
    await setJob(f.db, f.jobId, { lockedBy: "lost" });
    f.release();
    await f.turn;
    await setJob(f.db, f.jobId, { status: "done", lockedBy: null });
    // Every later re-verify ends without a Closeout result.
    (
      f.orchestrator as unknown as { candidateForItem: () => Promise<CandidateIdentity | null> }
    ).candidateForItem = async () => null;
    await enqueueJob(f.db, {
      queue: JOB_KIND.resume,
      payload: { itemId: item.id },
      now: Date.now(),
    });
    await f.tickAll();

    const delays: number[] = [];
    for (let fault = 1; fault <= 3; fault++) {
      const jobs = await closeoutFaultJobs(f.db);
      expect(jobs).toHaveLength(fault);
      const pending = jobs.at(-1)!;
      expect(pending.status).toBe("pending");
      expect(
        (pending.payload as { closeoutFaults: { reasons: string[] } }).closeoutFaults.reasons,
      ).toHaveLength(fault);
      delays.push(pending.runAt - pending.createdAt);
      expect(await findOpenQuestion(f.db, "ses_1")).toBeNull();
      await setJob(f.db, pending.id, { runAt: 0 });
      await f.tickReverify();
      await f.flush();
    }
    expect(delays).toEqual([60_000, 5 * 60_000, 15 * 60_000]);
    expect(await closeoutFaultJobs(f.db)).toHaveLength(3);
    expect((await getWorkItem(f.db, item.id))?.state).toBe("awaiting_input");
    expect((await findOpenQuestion(f.db, "ses_1"))?.kind).toBe("closeout-help");
    const asks = f.tracker.questions.filter((question) =>
      question.body.includes("Verification stopped without moving the task on"),
    );
    expect(asks).toHaveLength(1);
    expect(asks[0]!.body).toContain("Closeout stopped without a result 4 times on this head:");
    expect(await restartReasons(f.db, item.id)).toEqual([]);
  } finally {
    await f.close();
  }
}, 90_000);

test("a successful re-verify after one Closeout fault reaches the merge queue and clears the count", async () => {
  const f = await verifyingWithHeldGate();
  try {
    const item = (await listWorkItems(f.db))[0]!;
    f.throwFromRun(new DOMException("The operation was aborted.", "AbortError"));
    const interrupted = (await f.interrupt()).done;
    f.release();
    await f.turn;
    await interrupted;
    f.throwFromRun(null);
    const [retry] = await closeoutFaultJobs(f.db);
    await setJob(f.db, retry!.id, { runAt: 0 });
    await f.tickReverify();

    expect((await listJobs(f.db)).find((job) => job.id === retry!.id)?.status).toBe("done");
    expect((await getWorkItem(f.db, item.id))?.state).toBe("merge_queue");
    expect(await findOpenQuestion(f.db, "ses_1")).toBeNull();
    expect(
      (await listJobs(f.db)).filter(
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
    const item = (await listWorkItems(f.db))[0]!;
    const runId = item.currentRunId!;
    const jobId = await enqueueJob(f.db, {
      queue: JOB_KIND.reverify,
      payload: { itemId: item.id },
      maxAttempts: 1,
      now: Date.now(),
    });
    // Reproduce a duplicate dispatched outside the ordinary same-item claim exclusion.
    await setJob(f.db, f.jobId, { queue: "held-test-turn" });
    await f.tickReverify();
    await setJob(f.db, f.jobId, { queue: JOB_KIND.start });

    expect((await listJobs(f.db)).find((job) => job.id === jobId)).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: null,
    });
    expect(f.gate.runs).toHaveLength(1);
    expect(await getWorkItem(f.db, item.id)).toMatchObject({
      state: "verifying",
      currentRunId: runId,
    });
    expect(f.stalls()).toEqual([]);
    expect(await findOpenQuestion(f.db, "ses_1")).toBeNull();

    f.release();
    await f.turn;
    expect((await getWorkItem(f.db, item.id))?.state).toBe("merge_queue");
    await setJob(f.db, jobId, { runAt: 0 });
    await f.tickReverify();
    expect((await listJobs(f.db)).find((job) => job.id === jobId)?.status).toBe("done");
    // The run it waited for accepted the same head, so it starts no second run (PAS-1491).
    expect(f.gate.runs).toHaveLength(1);
    expect((await getWorkItem(f.db, item.id))?.state).toBe("merge_queue");
  } finally {
    f.release();
    await f.turn;
    await f.close();
  }
}, 90_000);

test("a check run whose lease lapsed keeps its claim, and a reverify waiting on it starts no second run", async () => {
  const f = await verifyingWithHeldGate({ remote: true });
  let release!: () => void;
  try {
    f.release();
    await f.turn;
    await f.restart();
    const item = (await listWorkItems(f.db))[0]!;
    const head = f.gate.runs[0]!.headSha;
    f.gate.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // As for PAS-1457: a closeout_fault re-verify runs the check run for the same head.
    const checkJob = await enqueueJob(f.db, {
      queue: JOB_KIND.reverify,
      payload: { itemId: item.id, reason: "closeout_fault", recheckHead: true },
      now: Date.now(),
    });
    const checking = f.tickReverify();
    while (f.gate.runs.length < 2) await Bun.sleep(10);
    const waiter = await enqueueJob(f.db, {
      queue: JOB_KIND.reverify,
      payload: { itemId: item.id },
      now: Date.now(),
    });
    // The renewal timer fell behind, so the running check job's lease lapsed, twice, across a
    // claim and a reverify poll.
    for (let poll = 0; poll < 2; poll++) {
      await setJob(f.db, checkJob, { lockedUntil: Date.now() - 60_000 });
      await setJob(f.db, waiter, { runAt: 0 });
      await f.tickReverify();
      expect((await listJobs(f.db)).find((job) => job.id === checkJob)).toMatchObject({
        status: "running",
        attempts: 1,
      });
      expect((await listJobs(f.db)).find((job) => job.id === waiter)).toMatchObject({
        status: "pending",
        attempts: 0,
      });
    }
    expect(f.gate.runs).toHaveLength(2);

    release();
    await checking;
    expect((await listJobs(f.db)).find((job) => job.id === checkJob)).toMatchObject({
      status: "done",
      lastError: null,
    });
    expect(await getWorkItem(f.db, item.id)).toMatchObject({
      state: "merge_queue",
      acceptedHead: head,
    });
    expect((await closeoutFaultJobs(f.db)).filter((job) => job.id !== checkJob)).toEqual([]);

    await setJob(f.db, waiter, { runAt: 0 });
    await f.tickReverify();
    expect((await listJobs(f.db)).find((job) => job.id === waiter)?.status).toBe("done");
    expect(f.gate.runs).toHaveLength(2);
  } finally {
    release?.();
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
      const item = (await listWorkItems(f.db))[0]!;
      // Reproduce the sibling context installed by the merge lane's hold().
      const contexts = (
        f.orchestrator as unknown as {
          jobContexts: Map<string, unknown>;
        }
      ).jobContexts;
      if (hold === "sibling")
        contexts.set(item.id, {
          isCurrent: async () => true,
          isCurrentSteps: () => syncSteps(() => true),
        });
      const jobId = await enqueueJob(f.db, {
        queue: JOB_KIND.reverify,
        payload: { itemId: item.id, decide: true },
        maxAttempts: 1,
        now: Date.now(),
      });
      await setJob(f.db, f.jobId, { queue: "held-test-turn" });
      await f.tickReverify();
      expect((await listJobs(f.db)).find((job) => job.id === jobId)).toMatchObject({
        status: "pending",
        attempts: 0,
        lastError: null,
        payload: { itemId: item.id, decide: true },
      });
      expect(f.gate.runs).toHaveLength(1);
      expect(f.gate.decisions).toHaveLength(0);
      expect(await findOpenQuestion(f.db, "ses_1")).toBeNull();
      if (hold === "sibling") contexts.delete(item.id);
      else {
        f.release();
        await f.turn;
      }
      await setJob(f.db, jobId, { runAt: 0 });
      await f.tickReverify();
      expect((await listJobs(f.db)).find((job) => job.id === jobId)).toMatchObject({
        status: "done",
        attempts: 1,
        lastError: null,
      });
      expect(f.gate.decisions).toHaveLength(1);
      expect((await getWorkItem(f.db, item.id))?.state).toBe("merge_queue");
    } finally {
      f.release();
      await f.turn;
      await f.close();
    }
  }, 90_000);

test("a deferred duplicate survives an aborted live Closeout with its flags", async () => {
  const f = await verifyingWithHeldGate({ remote: true });
  try {
    const item = (await listWorkItems(f.db))[0]!;
    const jobId = await enqueueJob(f.db, {
      queue: JOB_KIND.reverify,
      maxAttempts: 1,
      now: Date.now(),
      payload: { itemId: item.id, recheckHead: true, failClosed: true },
    });
    await setJob(f.db, f.jobId, { queue: "held-test-turn" });
    await f.tickReverify();
    expect((await listJobs(f.db)).find((job) => job.id === jobId)).toMatchObject({
      status: "pending",
      attempts: 0,
      payload: { itemId: item.id, recheckHead: true, failClosed: true },
    });
    f.throwFromRun(new DOMException("Lost original Closeout", "AbortError"));
    await setJob(f.db, f.jobId, { lockedBy: "lost" });
    f.release();
    await f.turn;
    f.throwFromRun(null);
    await setJob(f.db, f.jobId, { status: "done" });
    await setRunnerWork(f.db, item.currentRunId!, { endedAt: Date.now() });
    await setJob(f.db, jobId, { runAt: 0 });
    await f.tickReverify();
    expect((await listJobs(f.db)).find((job) => job.id === jobId)).toMatchObject({
      status: "done",
      lastError: null,
    });
    expect((await getWorkItem(f.db, item.id))?.state).toBe("merge_queue");
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
      const item = (await listWorkItems(f.db))[0]!;
      const runId = item.currentRunId!;
      await setRun(f.db, runId, { status: "active" });
      await setItem(f.db, item.id, { state: "verifying" });
      await setRunnerWork(f.db, runId, {
        endedAt: null,
        leaseUntil: Date.now() - RUNNER_LEASE_GRACE_MS - 1000,
      });
      await deliverRunnerResult(f.db, runId);
      if (scenario === "mismatch") {
        await setItem(f.db, item.id, { state: "merge_queue" });
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
        expect((await getWorkItem(f.db, item.id))?.currentRunId).toBe(runId);
        expect((await getRun(f.db, runId))?.status).toBe("active");
        expect(await runnerWorkOpen(f.db, runId)).toBe(true);
        if (scenario === "question") {
          await setItem(f.db, item.id, { state: "awaiting_input" });
          throw new DOMException("fixture question", "AbortError");
        }
        if (!importResult) throw new Error("fixture import interrupted");
        // The fake gate imports the delivered result, just as the remote backend does.
        await setRunnerWork(f.db, runId, { endedAt: Date.now() });
        imported = true;
        return verify(input);
      };
      const jobId = await enqueueJob(f.db, {
        queue: JOB_KIND.reverify,
        payload: { itemId: item.id },
        now: Date.now(),
        maxAttempts: scenario === "terminal" ? 1 : 2,
      });
      await f.tickReverify();
      if (scenario === "reader") {
        expect(f.gate.runs).toHaveLength(1);
        expect((await getRun(f.db, runId))?.status).toBe("active");
        expect((await listJobs(f.db)).find((j) => j.id === jobId)?.status).toBe("pending");
        readerBusy = false;
        await setJob(f.db, jobId, { runAt: 0 });
        await f.tickReverify();
      }
      expect(imported).toBe(importResult);
      const current = (await getWorkItem(f.db, item.id))!;
      if (scenario === "terminal") {
        expect(current.state).toBe("failed");
        expect((await getRun(f.db, runId))?.status).toBe("lost");
      } else if (scenario === "question") {
        expect(current.state).toBe("awaiting_input");
        expect((await getRun(f.db, runId))?.status).toBe("active");
      } else {
        expect((await listJobs(f.db)).find((job) => job.id === jobId)?.status).toBe(
          importResult ? "done" : "pending",
        );
        expect(current).toMatchObject({
          state: importResult || scenario === "mismatch" ? "merge_queue" : "verifying",
          currentRunId: runId,
        });
        expect((await getRun(f.db, runId))?.status).toBe(importResult ? "ended" : "active");
      }
      expect(await runnerWorkOpen(f.db, runId)).toBe(!importResult && scenario !== "terminal");
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
    const item = (await listWorkItems(f.db))[0]!;
    const contexts = (f.orchestrator as unknown as { jobContexts: Map<string, unknown> })
      .jobContexts;
    contexts.set(item.id, {
      isCurrent: async () => true,
      isCurrentSteps: () => syncSteps(() => true),
    });
    const jobId = await enqueueJob(f.db, {
      queue: JOB_KIND.reverify,
      now: Date.now(),
      maxAttempts: 1,
      payload: { itemId: item.id, verificationWaitSince: Date.now() - 20 * 60_000 },
    });
    await f.tickReverify();
    contexts.delete(item.id);
    expect((await listJobs(f.db)).find((job) => job.id === jobId)).toMatchObject({
      status: "pending",
      lastError: null,
    });
    expect((await getWorkItem(f.db, item.id))?.state).toBe("merge_queue");
    expect(await findOpenQuestion(f.db, "ses_1")).toBeNull();
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
    const item = (await listWorkItems(f.db))[0]!;
    const jobId = await enqueueJob(f.db, {
      queue: JOB_KIND.reverify,
      now: Date.now(),
      payload: { itemId: item.id, decide: true, verificationWaitSince: Date.now() - 30 * 60_000 },
    });
    await setJob(f.db, f.jobId, { queue: "held-test-turn" });
    await f.tickReverify();
    expect((await getWorkItem(f.db, item.id))?.state).toBe("verifying");
    expect(await findOpenQuestion(f.db, "ses_1")).toBeNull();
    expect((await listJobs(f.db)).find((j) => j.id === jobId)?.status).toBe("pending");
    f.release();
    await f.turn;
    expect((await getWorkItem(f.db, item.id))?.state).toBe("merge_queue");
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
    const item = (await listWorkItems(f.db))[0]!;
    await setRun(f.db, item.currentRunId!, { status: "active" });
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
    const jobId = await enqueueJob(f.db, {
      queue: JOB_KIND.reverify,
      now: Date.now(),
      payload: { itemId: item.id, verificationWaitSince: since },
    });
    await f.tickReverify();
    port.live.delete(item.currentRunId!);
    expect((await listJobs(f.db)).find((j) => j.id === jobId)).toMatchObject({
      status: "pending",
      payload: { verificationWaitSince: since },
      attempts: 0,
    });
    expect(f.gate.runs).toHaveLength(1);
    expect(await findOpenQuestion(f.db, "ses_1")).toBeNull();
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
      const item = (await listWorkItems(f.db))[0]!;
      await setItem(f.db, item.id, {
        state: state === "cancel-requested" ? "verifying" : state,
        cancelRequested: state === "cancel-requested" ? 1 : 0,
      });
      const contexts = (f.orchestrator as unknown as { jobContexts: Map<string, unknown> })
        .jobContexts;
      contexts.set(item.id, {
        isCurrent: async () => true,
        isCurrentSteps: () => syncSteps(() => true),
      });
      const jobId = await enqueueJob(f.db, {
        queue: JOB_KIND.reverify,
        payload: { itemId: item.id, verificationWaitSince: Date.now() - 30 * 60_000 },
        now: Date.now(),
      });
      await f.tickReverify();
      contexts.delete(item.id);
      expect((await listJobs(f.db)).find((job) => job.id === jobId)?.status).toBe("done");
      expect(await findOpenQuestion(f.db, "ses_1")).toBeNull();
      expect((await getWorkItem(f.db, item.id))?.state).toBe(
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
    const item = (await listWorkItems(f.db))[0]!;
    const contexts = (f.orchestrator as unknown as { jobContexts: Map<string, unknown> })
      .jobContexts;
    const jobId = await enqueueJob(f.db, {
      queue: JOB_KIND.reverify,
      payload: { itemId: item.id, verificationWaitSince: Date.now() - 19 * 60_000 },
      now: Date.now(),
    });
    let entered = false;
    f.gate.run = async () => {
      entered = true;
      expect((await listJobs(f.db)).find((job) => job.id === jobId)?.payload).not.toHaveProperty(
        "verificationWaitSince",
      );
      throw new Error("fixture transport pause");
    };
    await f.tickReverify();
    expect(entered).toBe(true);
    expect((await listJobs(f.db)).find((job) => job.id === jobId)?.status).toBe("pending");
    contexts.set(item.id, {
      isCurrent: async () => true,
      isCurrentSteps: () => syncSteps(() => true),
    });
    await setJob(f.db, jobId, { runAt: 0 });
    await f.tickReverify();
    contexts.delete(item.id);
    const waiting = (await listJobs(f.db)).find((job) => job.id === jobId)!;
    expect(waiting.status).toBe("pending");
    expect(
      (waiting.payload as { verificationWaitSince: number }).verificationWaitSince,
    ).toBeGreaterThan(Date.now() - 10_000);
    expect(await findOpenQuestion(f.db, "ses_1")).toBeNull();
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
      const item = (await listWorkItems(f.db))[0]!;
      const internals = f.orchestrator as unknown as {
        jobContexts: Map<string, unknown>;
        activitySession: () => string | null;
        askCloseoutHelp: () => Promise<void>;
      };
      await setRun(f.db, item.currentRunId!, { status: "active" });
      await setRunnerWork(f.db, item.currentRunId!, {
        endedAt: null,
        leaseUntil: Date.now() + 60_000,
      });
      if (problem === "no-session") internals.activitySession = () => null;
      else
        internals.askCloseoutHelp = async () => {
          throw new Error("fixture notification unavailable");
        };
      const jobId = await enqueueJob(f.db, {
        queue: JOB_KIND.reverify,
        maxAttempts: 1,
        payload: { itemId: item.id, verificationWaitSince: Date.now() - 30 * 60_000 },
        now: Date.now(),
      });
      await f.tickReverify();
      internals.jobContexts.delete(item.id);
      expect((await getWorkItem(f.db, item.id))?.state).toBe("failed");
      expect(["done", "cancelled"]).toContain(
        (await listJobs(f.db)).find((job) => job.id === jobId)?.status ?? "",
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
        const item = (await listWorkItems(f.db))[0]!;
        const runId = item.currentRunId!;
        // A rebased merge-queue head still needs a new round even with a verifying checkpoint.
        await setItem(f.db, item.id, {
          checkpoint: { ...(await checkpointOf(f.db, item.id)), phase: "verifying" },
        });
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
        await setRun(f.db, runId, { status: "active" });
        await setItem(f.db, item.id, { state: state });
        if (lease === "missing")
          await seed(f.db, (q) =>
            q.orm.delete(q.t.runnerWork).where(eq(q.t.runnerWork.runId, runId)),
          );
        else
          await setRunnerWork(f.db, runId, {
            endedAt: null,
            leaseUntil:
              Date.now() +
              (lease === "live"
                ? 60_000
                : lease === "grace"
                  ? -1_000
                  : -RUNNER_LEASE_GRACE_MS - 1_000),
          });
        const jobId = await enqueueJob(f.db, {
          queue: JOB_KIND.reverify,
          payload: { itemId: item.id },
          maxAttempts: 1,
          now: Date.now(),
        });
        await f.tickReverify();

        const waiting = lease === "live" || lease === "grace";
        expect((await listJobs(f.db)).find((job) => job.id === jobId)).toMatchObject({
          status: waiting ? "pending" : "done",
          attempts: waiting ? 0 : 1,
          lastError: null,
        });
        if (waiting) {
          expect(f.gate.runs).toHaveLength(1);
          expect((await getRun(f.db, runId))?.status).toBe("active");
          expect(await getWorkItem(f.db, item.id)).toMatchObject({
            state,
            currentRunId: runId,
          });
          // The same durable request must take over promptly once the lease expires.
          await setRunnerWork(f.db, runId, {
            leaseUntil: Date.now() - RUNNER_LEASE_GRACE_MS - 1_000,
          });
          await setJob(f.db, jobId, { runAt: 0 });
          await f.tickReverify();
          expect((await listJobs(f.db)).find((job) => job.id === jobId)).toMatchObject({
            status: "done",
            attempts: 1,
            lastError: null,
          });
        }
        {
          expect(f.gate.runs).toHaveLength(2);
          expect(rounds).toBe(state === "merge_queue" ? 1 : 0);
          expect((await getRun(f.db, runId))?.status).toBe("lost");
          expect(await runnerWorkOpen(f.db, runId)).toBe(false);
          const current = (await getWorkItem(f.db, item.id))!;
          expect(current.state).toBe("merge_queue");
          expect(current.currentRunId).not.toBe(runId);
          expect(await getRun(f.db, current.currentRunId!)).toMatchObject({
            kind: "recheck",
            status: "ended",
          });
        }
        expect(await findOpenQuestion(f.db, "ses_1")).toBeNull();
        expect(f.stalls()).toEqual([]);
        expect(
          await f.db.run((q) =>
            q.all(
              q.orm
                .select({ id: q.t.workItemEvent.id })
                .from(q.t.workItemEvent)
                .where(
                  and(
                    eq(q.t.workItemEvent.itemId, item.id),
                    eq(q.t.workItemEvent.event, "closeout_infra_failed"),
                  ),
                ),
            ),
          ),
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
    const item = (await listWorkItems(f.db))[0]!;
    f.gate.next = reviewExhausted(f.gate.runs[0]!.headSha);
    f.release();
    await f.turn;
    await f.flush();

    expect((await getWorkItem(f.db, item.id))?.state).toBe("awaiting_input");
    const question = (await findOpenQuestion(f.db, "ses_1"))!;
    expect(question.kind).toBe("link");
    expect(await getLinkAsk(f.db, question.id)).toMatchObject({
      kind: "rounds",
      link: "https://paws.example/dashboard/issues/ENG-7#review-rounds",
      rounds: { limit: 4, handoff: "Fix the P1 review finding." },
    });
    // The recovery row keeps the retry baseline a Rethink or Keep going grants.
    expect((await listCloseoutRecoveries(f.db, item.id)).map((entry) => entry.questionId)).toEqual([
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
    const item = (await listWorkItems(f.db))[0]!;
    f.gate.next = reviewExhausted(f.gate.runs[0]!.headSha);
    f.release();
    await f.turn;
    await f.flush();

    expect((await getWorkItem(f.db, item.id))?.state).toBe("awaiting_input");
    expect((await findOpenQuestion(f.db, "ses_1"))?.kind).toBe("closeout-help");
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
    const item = (await listWorkItems(f.db))[0]!;
    f.gate.next = ruleBroke(f.gate.runs[0]!.headSha);
    f.release();
    await f.turn;
    await f.flush();

    expect((await getWorkItem(f.db, item.id))?.state).toBe("awaiting_input");
    expect(await restartReasons(f.db, item.id)).toEqual([]);
    const question = (await findOpenQuestion(f.db, "ses_1"))!;
    expect(await getLinkAsk(f.db, question.id)).toMatchObject({
      kind: "rule",
      link: "https://paws.example/dashboard/issues/ENG-7#rule",
    });
    expect((await listCloseoutRecoveries(f.db, item.id))[0]?.failedChecks).toEqual([
      "api-contract",
    ]);
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
    const item = (await listWorkItems(f.db))[0]!;
    f.gate.next = ruleBroke(f.gate.runs[0]!.headSha, "failed");
    f.release();
    await f.turn;
    await f.flush();

    expect((await getWorkItem(f.db, item.id))?.state).toBe("queued");
    expect(await restartReasons(f.db, item.id)).toEqual(["findings"]);
    const resume = (await listJobs(f.db)).find(
      (job) => job.queue === JOB_KIND.resume && job.status === "pending",
    )!;
    const handoff = (resume.payload as { handoff: string }).handoff;
    expect(handoff).toContain("test (command): failed");
    expect(handoff).not.toContain("removed field Task.title");
  } finally {
    await f.close();
  }
}, 90_000);

async function restartReasons(db: Db, itemId: string): Promise<(string | null)[]> {
  const rows = await db.run((q) =>
    q.all(
      q.orm
        .select({ reason: q.t.workItemEvent.reason })
        .from(q.t.workItemEvent)
        .where(and(eq(q.t.workItemEvent.itemId, itemId), eq(q.t.workItemEvent.kind, "restart")))
        .orderBy(q.t.workItemEvent.id),
    ),
  );
  return rows.map((row) => row.reason);
}

type Values<K extends "job" | "run" | "workItem" | "runnerWork"> = Partial<
  Q["t"][K]["$inferInsert"]
>;

function setJob(db: Db, id: number, values: Values<"job">): Promise<void> {
  return seed(db, (q) => q.orm.update(q.t.job).set(values).where(eq(q.t.job.id, id)));
}

function setRun(db: Db, id: string, values: Values<"run">): Promise<void> {
  return seed(db, (q) => q.orm.update(q.t.run).set(values).where(eq(q.t.run.id, id)));
}

function setItem(db: Db, id: string, values: Values<"workItem">): Promise<void> {
  return seed(db, (q) => q.orm.update(q.t.workItem).set(values).where(eq(q.t.workItem.id, id)));
}

function setRunnerWork(db: Db, runId: string, values: Values<"runnerWork">): Promise<void> {
  return seed(db, (q) =>
    q.orm.update(q.t.runnerWork).set(values).where(eq(q.t.runnerWork.runId, runId)),
  );
}

async function checkpointOf(db: Db, id: string): Promise<object> {
  const [row] = await db.run((q) =>
    q.all(
      q.orm
        .select({ checkpoint: q.t.workItem.checkpoint })
        .from(q.t.workItem)
        .where(eq(q.t.workItem.id, id)),
    ),
  );
  return row!.checkpoint as object;
}

async function runnerWorkOpen(db: Db, runId: string): Promise<boolean> {
  const rows = await db.run((q) =>
    q.all(
      q.orm
        .select({ runId: q.t.runnerWork.runId })
        .from(q.t.runnerWork)
        .where(and(eq(q.t.runnerWork.runId, runId), isNull(q.t.runnerWork.endedAt))),
    ),
  );
  return rows.length > 0;
}

async function deliverRunnerResult(db: Db, runId: string): Promise<void> {
  const [work] = await db.run((q) =>
    q.all(q.orm.select().from(q.t.runnerWork).where(eq(q.t.runnerWork.runId, runId))),
  );
  const { commandId, runnerId, generation } = work!;
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.runnerCommand).values({
        id: commandId,
        runnerId,
        runId,
        generation,
        kind: "run",
        envelope: {},
        expiresAt: Date.now() + 60_000,
      }),
    (q) =>
      q.orm
        .insert(q.t.runnerResult)
        .values({ runId, generation, commandId, payload: {}, receivedAt: Date.now() }),
  );
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
  const { db, close: closeDb } = await tempStore();
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
      store: db,
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
  await seed(db, (q) => q.orm.update(q.t.workItem).set({ delegatedBy: "delegator-1" }));
  const turn = jobs.tick();
  await attachRunnerLease(db);
  const deadline = Date.now() + 30_000;
  while (gate.runs.length === 0) {
    if (Date.now() > deadline)
      throw new Error(
        JSON.stringify({
          items: await listWorkItems(db),
          lines,
          progress: tracker.progress,
        }),
      );
    await Bun.sleep(20);
  }
  const jobId = (await listJobs(db)).find((job) => job.status === "running")!.id;
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
    /** The held run throws this instead of returning its verdict. */
    throwFromRun(error: Error | null) {
      thrown = error;
    },
    turn,
    tracker,
    async interrupt() {
      const live = (
        orchestrator as unknown as { live: Map<string, { controller: AbortController }> }
      ).live;
      const interrupted = orchestrator.interruptLinearSession("ses_1");
      while ([...live.values()].some((entry) => !entry.controller.signal.aborted))
        await Bun.sleep(5);
      return { done: interrupted };
    },
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
      await closeDb();
      await layout.cleanup();
    },
  };
}

async function attachRunnerLease(db: Db): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) {
    const item = (await listWorkItems(db))[0];
    const run = item?.currentRunId ? await getRun(db, item.currentRunId) : null;
    if (run?.status === "active") {
      await seedRunnerLease(db, run.id);
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("implement run did not become active");
}

async function repoLayout() {
  const root = await mkdtemp(path.join(tmpdir(), "paws-closeout-stall-"));
  const bare = path.join(root, "origin.git");
  const clone = path.join(root, "seed");
  const pawsRoot = path.join(root, "paws");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(pawsRoot, { recursive: true });
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, clone]);
  await exec("git", ["-C", clone, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", clone, "config", "user.name", "Paws Test"]);
  await exec("git", ["-C", clone, "config", "commit.gpgsign", "false"]);
  await mkdir(path.join(clone, ".agents"), { recursive: true });
  await writeFile(path.join(clone, ".agents", "closeout.yaml"), POLICY);
  await writeFile(path.join(clone, "README.md"), "paws demo\n");
  await exec("git", ["-C", clone, "add", "."]);
  await exec("git", ["-C", clone, "commit", "-m", "init"]);
  await exec("git", ["-C", clone, "push", "origin", "HEAD:main"]);
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
    const item = (await listWorkItems(f.db))[0]!;
    const runId = item.currentRunId;
    f.gate.next = {
      decision: "blocked",
      exhausted: false,
      summary: "Closeout: blocked\nMessage: .agents/closeout.yaml could not be read",
    };
    f.release();
    await f.turn;
    await f.flush();
    const question = (await findOpenQuestion(f.db, "ses_1"))!;
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
    expect((await getWorkItem(f.db, item.id))?.state).toBe("verifying");
    expect(
      (await listJobs(f.db))
        .filter((job) => job.queue === JOB_KIND.reverify)
        .map((job) => job.jobKey),
    ).toEqual([`retry-closeout:${question.id}`]);
    await f.tickReverify();

    expect(await getWorkItem(f.db, item.id)).toMatchObject({
      state: "merge_queue",
      currentRunId: runId,
    });
    expect(f.gate.runs.map((run) => run.headSha)).toEqual([
      f.gate.runs[0]!.headSha,
      f.gate.runs[0]!.headSha,
    ]);
    expect(await restartReasons(f.db, item.id)).toEqual([]);
  } finally {
    await f.close();
  }
}, 90_000);
