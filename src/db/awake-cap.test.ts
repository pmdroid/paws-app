import { describe, expect, test } from "bun:test";
import { FakeClock, JOB_KIND } from "../core";
import {
  accrueAwake,
  accrueAtJobBoundary,
  applyWorkItemEvent,
  beginImplementRun,
  claimNextJob,
  completeJob,
  configureWorkItem,
  enqueueJob,
  getRun,
  getJob,
  parkLeasedJob,
  startUsagePause,
  endUsagePause,
  JobLoop,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  markCloseoutAccepted,
  markJobAwakeWait,
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
  accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
  clock.advance(10 * MINUTE);
  accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
  applyWorkItemEvent(db, item.id, "turn_ended");
  const verifying = verifyingJob(db, item.id, clock.now());
  clock.advance(5 * MINUTE);
  accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
  completeJob(db, verifying, clock.now());
  applyWorkItemEvent(db, item.id, "closeout_accepted");
  markCloseoutAccepted(db, item.id, "accepted");
  saveCheckpoint(db, item.id, { phase: "merge_queue", baseSha: "base", wipCommit: "accepted" });
  return { clock, db, item, run };
}

test("the job loop bills only active agent and Closeout work across every waiting stage", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(20_000);
  const item = insertQueuedItem(db, { maxAwakeMs: 30 * MINUTE, now: clock.now() });
  const jobs = new JobLoop(db, clock, { leaseMs: 24 * 60 * MINUTE });
  const accrue = () => accrueAwake(db, item.id, clock.mono(), clock.now()).item;
  accrue();
  clock.advance(60 * MINUTE);
  expect(accrue().awakeMs).toBe(0); // queued
  jobs.register(JOB_KIND.start, (job) => {
    const { run } = beginImplementRun(db, item.id, clock.now());
    expect(accrue().awakeMs).toBe(0);
    clock.advance(5 * MINUTE);
    expect(accrue().awakeMs).toBe(5 * MINUTE);
    startUsagePause(
      db,
      {
        itemId: item.id,
        runId: run.id,
        agent: "codex",
        runnerId: null,
        resetsAt: null,
        resumeAt: clock.now() + 120 * MINUTE,
        pausedAt: clock.now(),
      },
      clock.mono(),
    );
    clock.advance(120 * MINUTE);
    expect(accrue().awakeMs).toBe(5 * MINUTE);
    endUsagePause(db, run.id, clock.mono(), clock.now());
    for (const [enter, leave] of [
      ["blocking_question", "answer_received"],
      ["pause", "resume"],
    ] as const) {
      applyWorkItemEvent(db, item.id, enter);
      clock.advance(60 * MINUTE);
      expect(accrue().awakeMs).toBe(5 * MINUTE);
      applyWorkItemEvent(db, item.id, leave);
    }
    for (const reason of ["runner", "backoff"] as const) {
      markJobAwakeWait(db, job, true, clock.mono(), clock.now(), reason);
      clock.advance(60 * MINUTE);
      expect(accrue().awakeMs).toBe(5 * MINUTE);
      markJobAwakeWait(db, job, false, clock.mono(), clock.now(), reason);
    }
    clock.advance(3 * MINUTE);
    expect(accrue().awakeMs).toBe(8 * MINUTE);
    applyWorkItemEvent(db, item.id, "turn_ended");
    for (const reason of ["ci", "runner", "backoff"] as const) {
      markJobAwakeWait(db, job, true, clock.mono(), clock.now(), reason);
      clock.advance(60 * MINUTE);
      expect(accrue().awakeMs).toBe(8 * MINUTE);
      markJobAwakeWait(db, job, false, clock.mono(), clock.now(), reason);
    }
    clock.advance(2 * MINUTE);
    expect(accrue()).toMatchObject({
      awakeMs: 10 * MINUTE,
      agentMs: 8 * MINUTE,
      closeoutMs: 2 * MINUTE,
    });
    applyWorkItemEvent(db, item.id, "closeout_accepted");
    clock.advance(60 * MINUTE);
    expect(accrue().awakeMs).toBe(10 * MINUTE); // merge queue, even while the job is held
  });
  const id = enqueueJob(db, {
    queue: JOB_KIND.start,
    payload: { itemId: item.id },
    now: clock.now(),
  });
  db.run(
    "INSERT INTO scheduler_admission(item_id,job_id,project_key,repository_key,paths,hot,created_at) VALUES(?,?,'*','fixture','[]',0,?)",
    [item.id, id, clock.now()],
  );
  clock.advance(60 * MINUTE); // The claim must settle queued time even without a supervisor tick.
  expect(await jobs.tick([JOB_KIND.start])).not.toBeNull();
  expect(getWorkItem(db, item.id)).toMatchObject({ state: "merge_queue", awakeMs: 10 * MINUTE });
  db.close();
});

test("a live remote turn still counts without a local execution job", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(20_000);
  const item = insertQueuedItem(db, { maxAwakeMs: 30 * MINUTE, now: clock.now() });
  const { run } = beginImplementRun(db, item.id, clock.now());
  db.run("PRAGMA foreign_keys=OFF");
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,'runner','workspace',1,0,'command',?)",
    [run.id, clock.now() + 120 * MINUTE],
  );
  accrueAwake(db, item.id, clock.mono(), clock.now());
  clock.advance(5 * MINUTE);
  expect(accrueAwake(db, item.id, clock.mono(), clock.now()).item.awakeMs).toBe(5 * MINUTE);
  db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [clock.now(), run.id]);
  clock.advance(60 * MINUTE);
  expect(accrueAwake(db, item.id, clock.mono(), clock.now()).item.awakeMs).toBe(5 * MINUTE);
  db.close();
});

test("an idle running item and a control job do not spend the awake budget", () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(20_000);
  const item = insertQueuedItem(db, { maxAwakeMs: MINUTE, now: clock.now() });
  beginImplementRun(db, item.id, clock.now());
  accrueAwake(db, item.id, clock.mono(), clock.now());
  clock.advance(60 * MINUTE);
  expect(accrueAwake(db, item.id, clock.mono(), clock.now()).item.awakeMs).toBe(0);
  enqueueJob(db, { queue: "fixture.control", payload: { itemId: item.id }, now: clock.now() });
  claimNextJob(db, { queues: ["fixture.control"], now: clock.now(), leaseMs: 120 * MINUTE });
  clock.advance(60 * MINUTE);
  expect(accrueAwake(db, item.id, clock.mono(), clock.now()).item).toMatchObject({
    awakeMs: 0,
    waitingMs: 120 * MINUTE,
  });
  db.close();
});

test("a job retry backoff in running counts nothing and work resumes at the next claim", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(20_000);
  const item = insertQueuedItem(db, { maxAwakeMs: 30 * MINUTE, now: clock.now() });
  beginImplementRun(db, item.id, clock.now());
  const jobs = new JobLoop(db, clock, { leaseMs: 24 * 60 * MINUTE, backoffBaseMs: 60 * MINUTE });
  let attempts = 0;
  jobs.register(JOB_KIND.resume, () => {
    clock.advance(2 * MINUTE);
    if (++attempts === 1) throw new Error("temporary fixture failure");
  });
  enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: item.id }, now: clock.now() });
  await jobs.tick([JOB_KIND.resume]);
  expect(getWorkItem(db, item.id)?.awakeMs).toBe(2 * MINUTE);
  clock.advance(120 * MINUTE);
  expect(accrueAwake(db, item.id, clock.mono(), clock.now()).item.awakeMs).toBe(2 * MINUTE);
  await jobs.tick([JOB_KIND.resume]);
  expect(attempts).toBe(2);
  expect(getWorkItem(db, item.id)?.awakeMs).toBe(4 * MINUTE);
  db.close();
});

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
    applyWorkItemEvent(db, item.id, "restart", { kind: "restart", reason: "review" });
    applyWorkItemEvent(db, item.id, "dispatched");
    saveCheckpoint(db, item.id, { phase: "running", baseSha: "base", wipCommit: "accepted" });
    accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
    clock.advance(20 * MINUTE);

    enqueueJob(db, { queue: "run.resume", payload: { itemId: item.id }, now: clock.now() });
    enqueueJob(db, { queue: "github.merge", payload: { itemId: item.id }, now: clock.now() });
    const result = accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
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
    accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
    applyWorkItemEvent(db, item.id, "blocking_question");
    clock.advance(90 * MINUTE);
    accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
    applyWorkItemEvent(db, item.id, "answer_received");
    clock.advance(30 * MINUTE);
    expect(accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true).capped).toBe(true);
    expect(listOutbox(db).at(-1)?.payload).toMatchObject({
      kind: "error",
      body: "Run hit the awake time cap (30 min). Counted: agent turns 30 min, Closeout 0 min. Not counted: waiting 1 h 30 min.",
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
    const accrue = () =>
      accrueAwake(
        db,
        item.id,
        clock.mono(),
        clock.now(),
        undefined,
        getWorkItem(db, item.id)?.state === "running" ? true : undefined,
      );
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
      body: "Run hit the awake time cap (60 min). Counted: agent turns 41 min, Closeout 19 min. Not counted: waiting 4 h.",
    });
    finish();
    await running;
  });

  for (const state of ["running", "recovering"] as const) {
    test(`a ${state} slot wait settles before claim and bills work after claim`, () => {
      const clock = new FakeClock(20_000);
      const db = openDatabase(":memory:");
      migrate(db);
      const item = insertQueuedItem(db, { maxAwakeMs: 30 * MINUTE, now: clock.now() });
      const { run } = beginImplementRun(db, item.id, clock.now());
      if (state === "recovering") applyWorkItemEvent(db, item.id, "lease_expired");
      accrueAwake(db, item.id, clock.mono(), clock.now());
      enqueueJob(db, {
        queue: JOB_KIND.resume,
        payload: {
          itemId: item.id,
          capacityWait: { since: clock.now(), attempt: 0, runnerIds: ["runner"] },
        },
        now: clock.now(),
      });
      clock.advance(60 * MINUTE);
      const job = claimNextJob(db, {
        now: clock.now(),
        leaseMs: 10 * MINUTE,
        queues: [JOB_KIND.resume],
      })!;
      accrueAtJobBoundary(db, job, "claimed", clock.mono(), clock.now());
      expect(getWorkItem(db, item.id)).toMatchObject({
        state,
        currentRunId: run.id,
        awakeMs: 0,
        waitingMs: 60 * MINUTE,
      });
      clock.advance(2 * MINUTE);
      expect(accrueAwake(db, item.id, clock.mono(), clock.now()).item).toMatchObject({
        awakeMs: 2 * MINUTE,
        agentMs: 2 * MINUTE,
        waitingMs: 60 * MINUTE,
      });
      db.close();
    });
  }

  test("a Closeout run waiting on CI does not accrue closeout time", () => {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    migrate(db);
    const item = insertQueuedItem(db, { sessionKey: "ses", maxAwakeMs: 60 * MINUTE, now: 0 });
    beginImplementRun(db, item.id, clock.now());
    accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
    clock.advance(6 * MINUTE);
    accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
    applyWorkItemEvent(db, item.id, "turn_ended");
    const job = verifyingJob(db, item.id, clock.now());
    markJobAwakeWait(db, job, true, clock.mono(), clock.now());
    clock.advance(30 * MINUTE);
    const result = accrueAwake(db, item.id, clock.mono(), clock.now());
    expect(result.capped).toBe(false);
    expect(result.item).toMatchObject({
      awakeMs: 6 * MINUTE,
      agentMs: 6 * MINUTE,
      closeoutMs: 0,
      waitingMs: 30 * MINUTE,
    });
    markJobAwakeWait(db, job, false, clock.mono(), clock.now());
    clock.advance(2 * MINUTE);
    expect(accrueAwake(db, item.id, clock.mono(), clock.now()).item).toMatchObject({
      awakeMs: 8 * MINUTE,
      closeoutMs: 2 * MINUTE,
      waitingMs: 30 * MINUTE,
    });
  });

  test("a CI wait clears its pending job and cannot leak into a new claim", () => {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    migrate(db);
    const item = insertQueuedItem(db, { now: clock.now() });
    beginImplementRun(db, item.id, clock.now());
    applyWorkItemEvent(db, item.id, "turn_ended");
    const job = verifyingJob(db, item.id, clock.now());
    markJobAwakeWait(db, job, true, clock.mono(), clock.now());
    parkLeasedJob(db, job, {
      now: clock.now(),
      runAt: clock.now(),
      attempts: job.attempts,
      payload: getJob(db, job.id)!.payload,
    });
    markJobAwakeWait(db, job, false, clock.mono(), clock.now());
    expect(getJob(db, job.id)!.payload).not.toHaveProperty("awakeWait");
    const next = claimNextJob(db, {
      now: clock.now(),
      leaseMs: 60 * MINUTE,
      queues: [JOB_KIND.reverify],
    })!;
    // A late old writer cannot start a wait for its replacement.
    markJobAwakeWait(db, job, true, clock.mono(), clock.now());
    clock.advance(MINUTE);
    expect(accrueAwake(db, item.id, clock.mono(), clock.now()).item.closeoutMs).toBe(MINUTE);
    markJobAwakeWait(db, next, true, clock.mono(), clock.now());
    markJobAwakeWait(db, job, false, clock.mono(), clock.now());
    clock.advance(MINUTE);
    expect(accrueAwake(db, item.id, clock.mono(), clock.now()).item).toMatchObject({
      closeoutMs: MINUTE,
      waitingMs: MINUTE,
    });
    db.close();
  });

  test("an expired CI mark is ignored after reclaim and cannot clear a new owner's wait", () => {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    migrate(db);
    const item = insertQueuedItem(db, { now: clock.now() });
    beginImplementRun(db, item.id, clock.now());
    applyWorkItemEvent(db, item.id, "turn_ended");
    const job = verifyingJob(db, item.id, clock.now());
    const other = enqueueJob(db, {
      queue: "notification",
      payload: { itemId: item.id },
      now: clock.now(),
    });
    db.run("UPDATE job SET status='running', locked_by='other', locked_until=? WHERE id=?", [
      clock.now() + 60 * MINUTE,
      other,
    ]);
    markJobAwakeWait(db, job, true, clock.mono(), clock.now());
    expect(getJob(db, other)!.payload).not.toHaveProperty("awakeWait");
    db.run("UPDATE job SET locked_until=? WHERE id=?", [clock.now(), job.id]);
    const next = claimNextJob(db, {
      now: clock.now(),
      leaseMs: 60 * MINUTE,
      queues: [JOB_KIND.reverify],
    })!;
    expect(next).not.toBeNull();
    clock.advance(MINUTE);
    expect(accrueAwake(db, item.id, clock.mono(), clock.now()).item.closeoutMs).toBe(MINUTE);
    markJobAwakeWait(db, next, true, clock.mono(), clock.now());
    markJobAwakeWait(db, job, false, clock.mono(), clock.now());
    clock.advance(MINUTE);
    expect(accrueAwake(db, item.id, clock.mono(), clock.now()).item.waitingMs).toBe(MINUTE);
    db.close();
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
    db.run("UPDATE work_item SET accepted_head = NULL");
    applyWorkItemEvent(db, accepted.id, "reverify_requested");
    recoverOnStartup(db, clock.now());
    expect(getWorkItem(db, accepted.id)).toMatchObject({
      state: "verifying",
      checkpoint: { phase: "verifying" },
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
    applyWorkItemEvent(db, item.id, "restart", { kind: "restart", reason: "review" });
    applyWorkItemEvent(db, item.id, "dispatched");
    setCurrentRun(db, item.id, run.id);
    saveCheckpoint(db, item.id, { phase: "running", baseSha: "base", wipCommit: "accepted" });
    accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
    clock.advance(20 * MINUTE);
    enqueueJob(db, { queue: "run.resume", payload: { itemId: item.id }, now: clock.now() });
    enqueueJob(db, { queue: "github.merge", payload: { itemId: item.id }, now: clock.now() });

    const result = accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
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
