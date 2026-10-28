import { describe, expect, test } from "bun:test";
import { FakeClock, JOB_KIND } from "../core";
import {
  accrueAwake,
  applyWorkItemEvent,
  beginImplementRun,
  claimNextJob,
  completeJob,
  configureWorkItem,
  enqueueJob,
  getRun,
  JobLoop,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  markCloseoutAccepted,
  migrate,
  openDatabase,
  recoverOnStartup,
  saveCheckpoint,
  setCurrentRun,
} from "./index";

const MINUTE = 60_000;

function jobStatuses(db: ReturnType<typeof openDatabase>): Record<string, string> {
  return Object.fromEntries(
    listJobs(db)
      .filter((job) => job.status !== "done")
      .map((job) => [job.queue, job.status]),
  );
}

/** Claims a job for the item, as one holds it while Closeout verifies. */
function verifyingJob(db: ReturnType<typeof openDatabase>, itemId: string, now: number) {
  enqueueJob(db, { queue: JOB_KIND.reverify, payload: { itemId }, now });
  return claimNextJob(db, { now, leaseMs: 24 * 60 * MINUTE, queues: [JOB_KIND.reverify] })!;
}

function acceptedItem(maxAwakeMs: number) {
  const clock = new FakeClock(20_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, {
    id: "eng-7",
    sessionKey: "ses",
    maxAwakeMs,
    now: clock.now(),
  });
  const { run } = beginImplementRun(db, item.id, clock.now());
  accrueAwake(db, item.id, clock.mono(), clock.now());
  clock.advance(10 * MINUTE);
  accrueAwake(db, item.id, clock.mono(), clock.now());
  applyWorkItemEvent(db, item.id, "turn_ended");
  const verifying = verifyingJob(db, item.id, clock.now());
  clock.advance(5 * MINUTE);
  accrueAwake(db, item.id, clock.mono(), clock.now());
  completeJob(db, verifying, clock.now());
  applyWorkItemEvent(db, item.id, "closeout_accepted");
  markCloseoutAccepted(db, item.id, "accepted");
  saveCheckpoint(db, item.id, { phase: "merge_queue", baseSha: "base", wipCommit: "accepted" });
  return { clock, db, item, run };
}

describe("awake-time cap after Closeout accepted the work", () => {
  test("re-verification after a restart doesn't add awake time", () => {
    const { clock, db, item } = acceptedItem(3 * 60 * MINUTE);
    expect(getWorkItem(db, item.id)?.awakeMs).toBe(15 * MINUTE);
    applyWorkItemEvent(db, item.id, "reverify_requested");

    expect(recoverOnStartup(db, clock.now())).toEqual([{ type: "reverify" }]);
    const restarted = getWorkItem(db, item.id);
    expect(restarted?.state).toBe("verifying");
    expect(restarted?.checkpoint?.phase).toBe("verifying");
    expect(listJobs(db).some((job) => job.queue === "run.reverify")).toBe(true);

    accrueAwake(db, item.id, clock.mono(), clock.now());
    clock.advance(32 * MINUTE);
    const result = accrueAwake(db, item.id, clock.mono(), clock.now());
    expect(result.capped).toBe(false);
    expect(result.item).toMatchObject({
      awakeMs: 15 * MINUTE,
      agentMs: 10 * MINUTE,
      closeoutMs: 5 * MINUTE,
      recheckMs: 32 * MINUTE,
    });
  });

  test("past the cap, accepted work keeps publishing, merging and re-verifying", () => {
    const { clock, db, item } = acceptedItem(3 * 60 * MINUTE);
    configureWorkItem(db, item.id, { maxAwakeMs: MINUTE });
    clock.advance(4 * 60 * MINUTE);
    expect(accrueAwake(db, item.id, clock.mono(), clock.now()).capped).toBe(false);
    expect(getWorkItem(db, item.id)?.state).toBe("merge_queue");

    applyWorkItemEvent(db, item.id, "reverify_requested");
    recoverOnStartup(db, clock.now());
    clock.advance(60 * MINUTE);
    expect(accrueAwake(db, item.id, clock.mono(), clock.now()).capped).toBe(false);

    saveCheckpoint(db, item.id, { phase: "verifying", baseSha: "base", wipCommit: "newer" });
    clock.advance(60 * MINUTE);
    const verifying = accrueAwake(db, item.id, clock.mono(), clock.now());
    expect(verifying.capped).toBe(false);
    expect(verifying.item.state).toBe("verifying");
    expect(listOutbox(db).filter((row) => row.op === "elicitation")).toEqual([]);
  });

  test("a resumed agent at the cap asks in Linear instead of failing", () => {
    const { clock, db, item, run } = acceptedItem(30 * MINUTE);
    applyWorkItemEvent(db, item.id, "ejected");
    saveCheckpoint(db, item.id, { phase: "running", baseSha: "base", wipCommit: "accepted" });
    accrueAwake(db, item.id, clock.mono(), clock.now());
    clock.advance(20 * MINUTE);

    enqueueJob(db, { queue: "run.resume", payload: { itemId: item.id }, now: clock.now() });
    enqueueJob(db, { queue: "github.merge", payload: { itemId: item.id }, now: clock.now() });
    const result = accrueAwake(db, item.id, clock.mono(), clock.now());
    expect(result).toMatchObject({ capped: false, asked: true, stopAgent: true });
    expect(jobStatuses(db)).toEqual({
      "github.merge": "pending",
      "run.resume": "cancelled",
      "item.ask": "pending",
    });
    expect(result.item).toMatchObject({ state: "running", cancelRequested: false });
    expect(getRun(db, run.id)?.status).toBe("ended");
    const request = listJobs(db).find((job) => job.queue === "item.ask")?.payload;
    expect(request).toMatchObject({
      kind: "time-limit",
      options: ["Merge the accepted work", "Continue", "Stop"],
      body: expect.stringContaining("Time limit reached"),
    });
    expect(listOutbox(db).some((row) => (row.payload as { kind?: string }).kind === "error")).toBe(
      false,
    );
  });

  test("without an accepted candidate the cap still fails and says how the time was spent", () => {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    migrate(db);
    const item = insertQueuedItem(db, { sessionKey: "ses", maxAwakeMs: 30 * MINUTE, now: 0 });
    beginImplementRun(db, item.id, clock.now());
    accrueAwake(db, item.id, clock.mono(), clock.now());
    applyWorkItemEvent(db, item.id, "blocking_question");
    clock.advance(90 * MINUTE);
    accrueAwake(db, item.id, clock.mono(), clock.now());
    applyWorkItemEvent(db, item.id, "answer_received");
    clock.advance(30 * MINUTE);
    expect(accrueAwake(db, item.id, clock.mono(), clock.now()).capped).toBe(true);
    expect(listOutbox(db).at(-1)?.payload).toMatchObject({
      kind: "error",
      body: "Run hit the awake time cap (30 min). Counted: agent turns 30 min, Closeout 0 min. Not counted: waiting for answers 1 h 30 min.",
    });
  });

  test("verifying with no job working on it is not counted as Closeout time", async () => {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    migrate(db);
    const item = insertQueuedItem(db, { sessionKey: "ses", maxAwakeMs: 60 * MINUTE, now: 0 });
    const jobs = new JobLoop(db, clock, { leaseMs: 24 * 60 * MINUTE });
    let finish = () => {};
    jobs.register(
      JOB_KIND.reverify,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const verify = () => {
      enqueueJob(db, { queue: JOB_KIND.reverify, payload: { itemId: item.id }, now: clock.now() });
      // The claim is synchronous; the handler then holds the job until finish().
      return jobs.tick([JOB_KIND.reverify]);
    };
    const accrue = () => accrueAwake(db, item.id, clock.mono(), clock.now());
    beginImplementRun(db, item.id, clock.now());
    accrue();
    clock.advance(41 * MINUTE);
    accrue();
    applyWorkItemEvent(db, item.id, "turn_ended");

    // Two idle hours in verifying, then a job claims the item before the next accrual.
    clock.advance(2 * 60 * MINUTE);
    let running = verify();
    expect(getWorkItem(db, item.id)).toMatchObject({ awakeMs: 41 * MINUTE, closeoutMs: 0 });
    clock.advance(10 * MINUTE);
    accrue();
    // The job ends between accruals: its last five minutes still count.
    clock.advance(5 * MINUTE);
    finish();
    await running;
    clock.advance(2 * 60 * MINUTE);
    const idle = accrue();
    expect(idle.capped).toBe(false);
    expect(idle.item).toMatchObject({
      state: "verifying",
      awakeMs: 56 * MINUTE,
      agentMs: 41 * MINUTE,
      closeoutMs: 15 * MINUTE,
    });

    running = verify();
    clock.advance(4 * MINUTE);
    expect(accrue().capped).toBe(true);
    expect(listOutbox(db).at(-1)?.payload).toMatchObject({
      kind: "error",
      body: "Run hit the awake time cap (60 min). Counted: agent turns 41 min, Closeout 19 min.",
    });
    finish();
    await running;
  });

  test("a task Closeout accepted before the upgrade is still protected after a restart", () => {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    migrate(db);
    const item = insertQueuedItem(db, { sessionKey: "ses", maxAwakeMs: 30 * MINUTE, now: 0 });
    beginImplementRun(db, item.id, clock.now());
    applyWorkItemEvent(db, item.id, "turn_ended");
    applyWorkItemEvent(db, item.id, "closeout_accepted");
    saveCheckpoint(db, item.id, { phase: "merge_queue", baseSha: "base", wipCommit: "accepted" });
    for (const column of ["accepted_head", "agent_ms", "closeout_ms", "waiting_ms", "recheck_ms"])
      db.run(`ALTER TABLE work_item DROP COLUMN ${column}`);
    db.run("DELETE FROM schema_migration WHERE id = '117_work_item_awake_breakdown'");
    db.run("UPDATE work_item SET awake_ms = ? WHERE id = ?", [29 * MINUTE, item.id]);

    migrate(db);
    expect(getWorkItem(db, item.id)?.acceptedHead).toBe("accepted");
    applyWorkItemEvent(db, item.id, "reverify_requested");
    recoverOnStartup(db, clock.now());
    expect(getWorkItem(db, item.id)?.state).toBe("verifying");
    accrueAwake(db, item.id, clock.mono(), clock.now());
    clock.advance(32 * MINUTE);
    const result = accrueAwake(db, item.id, clock.mono(), clock.now());
    expect(result.capped).toBe(false);
    expect(result.item).toMatchObject({ awakeMs: 29 * MINUTE, recheckMs: 32 * MINUTE });
  });

  test("a task an older Paws already moved back to verifying is protected after the upgrade", () => {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    migrate(db);
    const accepted = insertQueuedItem(db, {
      id: "eng-1",
      sessionKey: "a",
      maxAwakeMs: 30 * MINUTE,
      now: 0,
    });
    beginImplementRun(db, accepted.id, clock.now());
    applyWorkItemEvent(db, accepted.id, "turn_ended");
    applyWorkItemEvent(db, accepted.id, "closeout_accepted");
    saveCheckpoint(db, accepted.id, {
      phase: "merge_queue",
      baseSha: "base",
      wipCommit: "accepted",
    });
    const fresh = insertQueuedItem(db, {
      id: "eng-2",
      sessionKey: "b",
      maxAwakeMs: 30 * MINUTE,
      now: 0,
    });
    beginImplementRun(db, fresh.id, clock.now());
    applyWorkItemEvent(db, fresh.id, "turn_ended");
    saveCheckpoint(db, fresh.id, { phase: "verifying", baseSha: "base", wipCommit: "unchecked" });
    db.run("UPDATE work_item SET accepted_head = NULL");
    applyWorkItemEvent(db, accepted.id, "reverify_requested");
    recoverOnStartup(db, clock.now());
    expect(getWorkItem(db, accepted.id)).toMatchObject({
      state: "verifying",
      checkpoint: { phase: "verifying" },
    });
    for (const column of ["accepted_head", "agent_ms", "closeout_ms", "waiting_ms", "recheck_ms"])
      db.run(`ALTER TABLE work_item DROP COLUMN ${column}`);
    db.run("DELETE FROM schema_migration WHERE id = '117_work_item_awake_breakdown'");
    db.run("UPDATE work_item SET awake_ms = ? WHERE id = ?", [29 * MINUTE, accepted.id]);

    migrate(db);
    expect(getWorkItem(db, accepted.id)?.acceptedHead).toBe("accepted");
    expect(getWorkItem(db, fresh.id)?.acceptedHead).toBeNull();
    accrueAwake(db, accepted.id, clock.mono(), clock.now());
    clock.advance(32 * MINUTE);
    const result = accrueAwake(db, accepted.id, clock.mono(), clock.now());
    expect(result.capped).toBe(false);
    expect(result.item).toMatchObject({ awakeMs: 29 * MINUTE, recheckMs: 32 * MINUTE });
  });

  test("without a Linear session, a resumed agent at the cap pauses instead of failing", () => {
    const { clock, db, item, run } = acceptedItem(30 * MINUTE);
    db.run("UPDATE work_item SET session_key = NULL WHERE id = ?", [item.id]);
    applyWorkItemEvent(db, item.id, "ejected");
    setCurrentRun(db, item.id, run.id);
    saveCheckpoint(db, item.id, { phase: "running", baseSha: "base", wipCommit: "accepted" });
    accrueAwake(db, item.id, clock.mono(), clock.now());
    clock.advance(20 * MINUTE);
    enqueueJob(db, { queue: "run.resume", payload: { itemId: item.id }, now: clock.now() });
    enqueueJob(db, { queue: "github.merge", payload: { itemId: item.id }, now: clock.now() });

    const result = accrueAwake(db, item.id, clock.mono(), clock.now());
    expect(result).toMatchObject({ capped: false, stopAgent: true });
    expect(jobStatuses(db)).toEqual({ "github.merge": "pending", "run.resume": "cancelled" });
    expect(result.item).toMatchObject({
      state: "paused",
      cancelRequested: false,
      maxAwakeMs: 35 * MINUTE + 60 * MINUTE,
    });
    expect(getRun(db, run.id)?.status).toBe("ended");
    expect(listOutbox(db).some((row) => (row.payload as { kind?: string }).kind === "error")).toBe(
      false,
    );
    expect(listOutbox(db).at(-1)?.payload).toMatchObject({
      kind: "thought",
      body: expect.stringMatching(/^Paused at the time limit\. /),
    });
  });
});
