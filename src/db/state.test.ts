import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandBus, FakeClock, handoffNote, JOB_KIND, type Checkpoint } from "../core";
import {
  accrueAwake,
  applyWorkItemEvent,
  beginImplementRun,
  claimNextJob,
  completeJob,
  enqueueJob,
  enqueueJobOnce,
  enterMergeQueue,
  getJob,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  markRun,
  migrate,
  openDatabase,
  prepareShutdown,
  recordTurn,
  recoverOnStartup,
  saveCheckpoint,
  saveRunResult,
  submitCommand,
  syncClock,
  TransitionRejectedError,
} from "./index";

function harness() {
  const clock = new FakeClock(20_000);
  const db = openDatabase(":memory:");
  migrate(db);
  return { clock, db };
}

const checkpoint: Checkpoint = { phase: "running", wipCommit: "wip", turn: 2, baseSha: "base" };

describe("restart recovery", () => {
  test("the first start resumes from the checkpoint and the next one fails the item", () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { id: "eng-1", sessionKey: "ses", now: clock.now() });
    const { run } = beginImplementRun(db, item.id, clock.now(), checkpoint);

    expect(recoverOnStartup(db, clock.now())).toEqual([
      { type: "resume", freshSession: true, checkpoint },
    ]);
    expect(getWorkItem(db, item.id)).toMatchObject({ state: "recovering", recoveryAttempts: 1 });
    expect(getRun(db, run.id)?.status).toBe("active");
    expect(listOutbox(db)).toHaveLength(0);
    const resume = listJobs(db).find((job) => job.queue === "run.resume");
    expect(resume?.status).toBe("pending");
    expect(resume?.payload).toMatchObject({ freshSession: true, runId: run.id, checkpoint });

    expect(recoverOnStartup(db, clock.now())[0]).toEqual({
      type: "fail",
      reason: "resume_already_attempted",
    });
    expect(getWorkItem(db, item.id)?.state).toBe("failed");
    expect(getRun(db, run.id)?.status).toBe("lost");
    expect(listJobs(db).find((job) => job.queue === "run.resume")?.status).toBe("cancelled");
    expect(listOutbox(db)).toHaveLength(1);
  });

  test("a run with no checkpoint fails", () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { now: clock.now() });
    beginImplementRun(db, item.id, clock.now());
    expect(recoverOnStartup(db, clock.now())[0]).toEqual({ type: "fail", reason: "no_checkpoint" });
    expect(getWorkItem(db, item.id)?.state).toBe("failed");
  });

  test("shutdown leaves the run recoverable and the next start can resume it once", () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { now: clock.now() });
    const { run } = beginImplementRun(db, item.id, clock.now(), checkpoint);
    prepareShutdown(db, clock.now());
    expect(getWorkItem(db, item.id)).toMatchObject({ state: "recovering", recoveryAttempts: 0 });
    expect(getRun(db, run.id)?.status).toBe("lost");

    recoverOnStartup(db, clock.now());
    expect(getWorkItem(db, item.id)).toMatchObject({ state: "recovering", recoveryAttempts: 1 });
    expect(getRun(db, run.id)?.status).toBe("active");

    prepareShutdown(db, clock.now());
    expect(getWorkItem(db, item.id)?.recoveryAttempts).toBe(1);
    recoverOnStartup(db, clock.now());
    expect(getWorkItem(db, item.id)?.state).toBe("failed");
  });

  test("a merge that was in progress is re-verified and does not continue", () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, {
      id: "eng-1",
      branchName: "paws/eng-1",
      now: clock.now(),
    });
    beginImplementRun(db, item.id, clock.now(), checkpoint);
    enterMergeQueue(db, item.id, checkpoint);
    const merge = enqueueJob(db, {
      queue: "github.merge",
      lane: "merge",
      payload: { itemId: item.id },
      now: clock.now(),
    });
    const leased = claimNextJob(db, {
      workerId: "merger",
      now: clock.now(),
      queues: ["github.merge"],
    });

    expect(recoverOnStartup(db, clock.now())[0]).toEqual({ type: "reverify" });
    expect(getWorkItem(db, item.id)?.state).toBe("verifying");
    expect(getWorkItem(db, item.id)?.checkpoint?.phase).toBe("verifying");
    expect(getWorkItem(db, item.id)?.branchName).toBe("paws/eng-1");
    expect(getJob(db, merge)?.status).toBe("cancelled");
    expect(leased !== null && completeJob(db, leased, clock.now())).toBe(false);
    expect(
      listJobs(db).some((job) => job.queue === "run.reverify" && job.status === "pending"),
    ).toBe(true);
    expect(listOutbox(db)).toHaveLength(0);
  });

  test("a question that is waiting for Linear survives a restart", () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { now: clock.now() });
    const { run } = beginImplementRun(db, item.id, clock.now());
    applyWorkItemEvent(db, item.id, "blocking_question");
    saveCheckpoint(db, item.id, { ...checkpoint, phase: "awaiting_input" });
    expect(recoverOnStartup(db, clock.now())).toEqual([]);
    expect(getWorkItem(db, item.id)?.state).toBe("awaiting_input");
    expect(getWorkItem(db, item.id)?.recoveryAttempts).toBe(0);
    expect(getRun(db, run.id)?.status).toBe("ended");
    expect(listJobs(db)).toHaveLength(0);
  });

  test("an answered question at startup resumes once and an open question stays parked", () => {
    const { db, clock } = harness();
    const waiting = insertQueuedItem(db, {
      id: "waiting",
      sessionKey: "ses-wait",
      now: clock.now(),
    });
    const answered = insertQueuedItem(db, {
      id: "answered",
      sessionKey: "ses-ans",
      now: clock.now(),
    });
    const waitingRun = beginImplementRun(db, waiting.id, clock.now()).run;
    const answeredRun = beginImplementRun(db, answered.id, clock.now()).run;
    applyWorkItemEvent(db, waiting.id, "blocking_question");
    applyWorkItemEvent(db, answered.id, "blocking_question");
    db.run(
      `INSERT INTO question (
         id, item_id, run_id, session_id, body, options, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      ["q-wait", waiting.id, waitingRun.id, "ses-wait", "Still waiting?", null, clock.now()],
    );
    db.run(
      `INSERT INTO question (
         id, item_id, run_id, session_id, body, options, status, answer, answered_by,
         created_at, answered_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'answered', ?, ?, ?, ?)`,
      [
        "q-ans",
        answered.id,
        answeredRun.id,
        "ses-ans",
        "Which format?",
        JSON.stringify(["yes", "no"]),
        "parquet",
        "human",
        clock.now(),
        clock.now() + 1,
      ],
    );

    expect(recoverOnStartup(db, clock.now() + 2)).toEqual([]);
    expect(getWorkItem(db, waiting.id)?.state).toBe("awaiting_input");
    expect(getRun(db, waitingRun.id)?.status).toBe("ended");
    expect(getWorkItem(db, answered.id)).toMatchObject({
      state: "running",
      recoveryAttempts: 0,
    });
    expect(getRun(db, answeredRun.id)?.status).toBe("ended");
    expect(listJobs(db)).toEqual([
      expect.objectContaining({
        queue: JOB_KIND.resume,
        jobKey: "resume:answer:q-ans",
        status: "pending",
        payload: {
          itemId: answered.id,
          freshSession: true,
          reason: "answer",
          handoff: handoffNote({
            question: "Which format?",
            options: ["yes", "no"],
            answer: "parquet",
          }),
        },
      }),
    ]);
  });

  test("a restart leaves an answered item to its pending answer resume", () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { id: "answered", sessionKey: "ses", now: clock.now() });
    const { run } = beginImplementRun(db, item.id, clock.now(), checkpoint);
    applyWorkItemEvent(db, item.id, "blocking_question");
    markRun(db, run.id, "ended", clock.now());
    applyWorkItemEvent(db, item.id, "answer_received");
    enqueueJobOnce(db, {
      queue: JOB_KIND.resume,
      jobKey: "resume:answer:q-1",
      payload: { itemId: item.id, freshSession: true, reason: "answer", handoff: "Q and A" },
      now: clock.now(),
    });
    expect(recoverOnStartup(db, clock.now() + 1)).toEqual([]);
    expect(getWorkItem(db, item.id)).toMatchObject({ state: "running", recoveryAttempts: 0 });
    expect(listJobs(db).map((job) => job.jobKey)).toEqual(["resume:answer:q-1"]);
  });

  test("illegal transitions do not change the row", () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { now: clock.now() });
    expect(() => applyWorkItemEvent(db, item.id, "merge_accepted")).toThrow(
      TransitionRejectedError,
    );
    expect(getWorkItem(db, item.id)?.state).toBe("queued");
  });

  test("a new process resumes a running item once and does not post a duplicate activity", () => {
    const dir = mkdtempSync(join(tmpdir(), "paws-runtime-"));
    const path = join(dir, "paws.db");
    const clock = new FakeClock(0);
    const first = openDatabase(path);
    migrate(first);
    insertQueuedItem(first, { id: "eng-1", sessionKey: "ses", now: clock.now() });
    const { run } = beginImplementRun(first, "eng-1", clock.now(), checkpoint);
    saveRunResult(first, run.id, "Implemented and checked locally.", clock.now());
    first.close();

    const second = openDatabase(path);
    migrate(second);
    const recovery = recoverOnStartup(second, clock.now());
    expect(getWorkItem(second, "eng-1")).toMatchObject({
      state: "recovering",
      recoveryAttempts: 1,
    });
    expect(getRun(second, run.id)?.status).toBe("active");
    expect(getRun(second, run.id)?.checkpoint?.resultBody).toBe("Implemented and checked locally.");
    expect(recovery).toEqual([{ type: "resume", freshSession: true, checkpoint }]);
    expect(listOutbox(second)).toHaveLength(0);
    expect(listJobs(second).filter((job) => job.queue === JOB_KIND.resume)).toHaveLength(1);
    second.close();
  });
});

describe("hard caps", () => {
  test("the turn cap fails the item", () => {
    const { db, clock } = harness();
    const item = insertQueuedItem(db, { sessionKey: "ses", maxTurns: 2, now: clock.now() });
    beginImplementRun(db, item.id, clock.now());
    expect(recordTurn(db, item.id, clock.now()).capped).toBe(false);
    expect(recordTurn(db, item.id, clock.now()).capped).toBe(true);
    expect(getWorkItem(db, item.id)).toMatchObject({
      state: "failed",
      turnCount: 2,
      cancelRequested: true,
    });
    expect(recordTurn(db, item.id, clock.now()).item.turnCount).toBe(2);
    expect(listOutbox(db)).toHaveLength(1);
    expect(listOutbox(db)[0]?.payload).toEqual({
      sessionId: "ses",
      kind: "error",
      body: "Run hit the turn cap (2).",
    });
  });

  test("awake time counts monotonic time and ignores a wall-clock sleep", () => {
    const { clock, db } = harness();
    const item = insertQueuedItem(db, { maxAwakeMs: 1_000, now: clock.now() });
    beginImplementRun(db, item.id, clock.now());
    accrueAwake(db, item.id, clock.mono(), clock.now());
    clock.sleep(3 * 60 * 60_000);
    clock.advance(400);
    expect(accrueAwake(db, item.id, clock.mono(), clock.now()).item.awakeMs).toBe(400);
    expect(getWorkItem(db, item.id)?.state).toBe("running");
    clock.advance(600);
    expect(accrueAwake(db, item.id, clock.mono(), clock.now()).capped).toBe(true);
    expect(getWorkItem(db, item.id)?.state).toBe("failed");
    expect(listOutbox(db)[0]?.payload).toEqual({
      sessionId: item.sessionKey ?? item.id,
      kind: "error",
      body: "Run hit the awake time cap (1 min).",
    });
  });

  test("time parked for a Linear answer is not awake time", () => {
    const { clock, db } = harness();
    const item = insertQueuedItem(db, { maxAwakeMs: 50_000, now: clock.now() });
    beginImplementRun(db, item.id, clock.now());
    accrueAwake(db, item.id, clock.mono(), clock.now());
    applyWorkItemEvent(db, item.id, "blocking_question");
    clock.advance(10_000);
    syncClock(db, item.id, clock.mono());
    applyWorkItemEvent(db, item.id, "answer_received");
    clock.advance(100);
    expect(accrueAwake(db, item.id, clock.mono(), clock.now()).item.awakeMs).toBe(100);
  });
});

describe("linear commands", () => {
  test("a stop is applied before the call returns", () => {
    const { db, clock } = harness();
    const seen: string[] = [];
    const bus = new CommandBus();
    bus.subscribe((command) => {
      seen.push(command.type);
    });
    insertQueuedItem(db, { id: "eng-2", sessionKey: "ses", now: clock.now() });
    const { run } = beginImplementRun(db, "eng-2", clock.now());
    enqueueJob(db, {
      queue: "github.merge",
      lane: "merge",
      payload: { itemId: "eng-2" },
      now: clock.now(),
    });
    const merge = claimNextJob(db, {
      workerId: "merger",
      now: clock.now(),
      queues: ["github.merge"],
    });

    const result = submitCommand(db, bus, {
      type: "stop",
      source: "linear",
      itemId: "eng-2",
      requestedAt: clock.now(),
    });

    expect(result.applied).toBe(true);
    expect(seen).toEqual(["stop"]);
    expect(getWorkItem(db, "eng-2")).toMatchObject({ state: "cancelled", cancelRequested: true });
    expect(getRun(db, run.id)?.status).toBe("lost");
    expect(listOutbox(db)[0]?.payload).toEqual({
      sessionId: "ses",
      kind: "response",
      body: "Stopped from Linear.",
      id: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    });
    expect(merge).not.toBeNull();
    expect(merge !== null && completeJob(db, merge, clock.now())).toBe(false);

    submitCommand(db, bus, {
      type: "cancel",
      source: "linear",
      itemId: "eng-2",
      requestedAt: clock.now() + 1,
    });
    expect(seen).toEqual(["stop"]);
    expect(listOutbox(db)).toHaveLength(1);
  });

  test("a shared session receives one final stop acknowledgement", () => {
    const { db, clock } = harness();
    const bus = new CommandBus();
    for (const id of ["first", "second"]) {
      insertQueuedItem(db, { id, sessionKey: "ses", now: clock.now() });
      submitCommand(db, bus, {
        type: "stop",
        source: "linear",
        itemId: id,
        requestedAt: clock.now(),
      });
    }
    expect(listOutbox(db)).toHaveLength(1);
    expect(listOutbox(db)[0]?.payload).toMatchObject({ kind: "response", sessionId: "ses" });
    db.close();
  });

  test("a listener error stays on the command and the item stays cancelled", () => {
    const { db, clock } = harness();
    const bus = new CommandBus();
    bus.subscribe(() => {
      throw new Error("listener blew up");
    });
    insertQueuedItem(db, { id: "eng-4", now: clock.now() });
    beginImplementRun(db, "eng-4", clock.now());
    submitCommand(db, bus, {
      type: "cancel",
      source: "linear",
      itemId: "eng-4",
      requestedAt: clock.now(),
    });
    expect(getWorkItem(db, "eng-4")?.state).toBe("cancelled");
    expect(listJobs(db).find((job) => job.queue === JOB_KIND.command)?.lastError).toBe(
      "listener blew up",
    );
  });
});
