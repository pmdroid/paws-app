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
  legacyMigrate,
  openDatabase,
  recoverOnStartup,
  saveCheckpoint,
  setCurrentRun,
  startAgentWait,
  endAgentWait,
  sqliteDb,
} from "./index";

const MINUTE = 60_000;

async function jobStatuses(db: ReturnType<typeof openDatabase>): Promise<Record<string, string>> {
  return Object.fromEntries(
    (await listJobs(sqliteDb(db)))
      .filter((job) => job.status !== "done")
      .map((job) => [job.queue, job.status]),
  );
}

/** Claims a job for the item, as one holds it while Closeout verifies. */
async function verifyingJob(db: ReturnType<typeof openDatabase>, itemId: string, now: number) {
  await enqueueJob(sqliteDb(db), { queue: JOB_KIND.reverify, payload: { itemId }, now });
  return (await claimNextJob(sqliteDb(db), {
    now,
    leaseMs: 24 * 60 * MINUTE,
    queues: [JOB_KIND.reverify],
  }))!;
}

async function acceptedItem(maxAwakeMs: number) {
  const clock = new FakeClock(20_000);
  const db = openDatabase(":memory:");
  legacyMigrate(db);
  const item = insertQueuedItem(db, {
    id: "eng-7",
    sessionKey: "ses",
    maxAwakeMs,
    now: clock.now(),
  });
  const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now());
  await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
  clock.advance(10 * MINUTE);
  await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
  await applyWorkItemEvent(sqliteDb(db), item.id, "turn_ended");
  const verifying = await verifyingJob(db, item.id, clock.now());
  clock.advance(5 * MINUTE);
  await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
  await completeJob(sqliteDb(db), verifying, clock.now());
  await applyWorkItemEvent(sqliteDb(db), item.id, "closeout_accepted");
  await markCloseoutAccepted(sqliteDb(db), item.id, "accepted");
  saveCheckpoint(db, item.id, { phase: "merge_queue", baseSha: "base", wipCommit: "accepted" });
  return { clock, db, item, run };
}

test("the job loop bills only active agent and Closeout work across every waiting stage", async () => {
  const db = openDatabase(":memory:");
  legacyMigrate(db);
  const clock = new FakeClock(20_000);
  const item = insertQueuedItem(db, { maxAwakeMs: 30 * MINUTE, now: clock.now() });
  const jobs = new JobLoop(db, clock, { leaseMs: 24 * 60 * MINUTE });
  const accrue = async () =>
    (await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now())).item;
  await accrue();
  clock.advance(60 * MINUTE);
  expect((await accrue()).awakeMs).toBe(0); // queued
  jobs.register(JOB_KIND.start, async (job) => {
    const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now());
    expect((await accrue()).awakeMs).toBe(0);
    clock.advance(5 * MINUTE);
    expect((await accrue()).awakeMs).toBe(5 * MINUTE);
    await startUsagePause(
      sqliteDb(db),
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
    expect((await accrue()).awakeMs).toBe(5 * MINUTE);
    await endUsagePause(sqliteDb(db), run.id, clock.mono(), clock.now());
    for (const [enter, leave] of [
      ["blocking_question", "answer_received"],
      ["pause", "resume"],
    ] as const) {
      await applyWorkItemEvent(sqliteDb(db), item.id, enter);
      clock.advance(60 * MINUTE);
      expect((await accrue()).awakeMs).toBe(5 * MINUTE);
      await applyWorkItemEvent(sqliteDb(db), item.id, leave);
    }
    for (const reason of ["runner", "backoff"] as const) {
      await markJobAwakeWait(sqliteDb(db), job, true, clock.mono(), clock.now(), reason);
      clock.advance(60 * MINUTE);
      expect((await accrue()).awakeMs).toBe(5 * MINUTE);
      await markJobAwakeWait(sqliteDb(db), job, false, clock.mono(), clock.now(), reason);
    }
    clock.advance(3 * MINUTE);
    expect((await accrue()).awakeMs).toBe(8 * MINUTE);
    await applyWorkItemEvent(sqliteDb(db), item.id, "turn_ended");
    for (const reason of ["ci", "runner", "backoff"] as const) {
      await markJobAwakeWait(sqliteDb(db), job, true, clock.mono(), clock.now(), reason);
      clock.advance(60 * MINUTE);
      expect((await accrue()).awakeMs).toBe(8 * MINUTE);
      await markJobAwakeWait(sqliteDb(db), job, false, clock.mono(), clock.now(), reason);
    }
    clock.advance(2 * MINUTE);
    expect(await accrue()).toMatchObject({
      awakeMs: 10 * MINUTE,
      agentMs: 8 * MINUTE,
      closeoutMs: 2 * MINUTE,
    });
    await applyWorkItemEvent(sqliteDb(db), item.id, "closeout_accepted");
    clock.advance(60 * MINUTE);
    expect((await accrue()).awakeMs).toBe(10 * MINUTE); // merge queue, even while the job is held
  });
  const id = await enqueueJob(sqliteDb(db), {
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

test("a live remote turn still counts without a local execution job", async () => {
  const db = openDatabase(":memory:");
  legacyMigrate(db);
  const clock = new FakeClock(20_000);
  const item = insertQueuedItem(db, { maxAwakeMs: 30 * MINUTE, now: clock.now() });
  const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now());
  db.run("PRAGMA foreign_keys=OFF");
  db.run(
    "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,'runner','workspace',1,0,'command',?)",
    [run.id, clock.now() + 120 * MINUTE],
  );
  await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now());
  clock.advance(5 * MINUTE);
  expect((await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now())).item.awakeMs).toBe(
    5 * MINUTE,
  );
  db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [clock.now(), run.id]);
  clock.advance(60 * MINUTE);
  expect((await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now())).item.awakeMs).toBe(
    5 * MINUTE,
  );
  db.close();
});

test("an idle running item and a control job do not spend the awake budget", async () => {
  const db = openDatabase(":memory:");
  legacyMigrate(db);
  const clock = new FakeClock(20_000);
  const item = insertQueuedItem(db, { maxAwakeMs: MINUTE, now: clock.now() });
  await beginImplementRun(sqliteDb(db), item.id, clock.now());
  await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now());
  clock.advance(60 * MINUTE);
  expect((await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now())).item.awakeMs).toBe(
    0,
  );
  await enqueueJob(sqliteDb(db), {
    queue: "fixture.control",
    payload: { itemId: item.id },
    now: clock.now(),
  });
  await claimNextJob(sqliteDb(db), {
    queues: ["fixture.control"],
    now: clock.now(),
    leaseMs: 120 * MINUTE,
  });
  clock.advance(60 * MINUTE);
  expect((await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now())).item).toMatchObject({
    awakeMs: 0,
    waitingMs: 120 * MINUTE,
  });
  db.close();
});

test("a job retry backoff in running counts nothing and work resumes at the next claim", async () => {
  const db = openDatabase(":memory:");
  legacyMigrate(db);
  const clock = new FakeClock(20_000);
  const item = insertQueuedItem(db, { maxAwakeMs: 30 * MINUTE, now: clock.now() });
  await beginImplementRun(sqliteDb(db), item.id, clock.now());
  const jobs = new JobLoop(db, clock, { leaseMs: 24 * 60 * MINUTE, backoffBaseMs: 60 * MINUTE });
  let attempts = 0;
  jobs.register(JOB_KIND.resume, () => {
    clock.advance(2 * MINUTE);
    if (++attempts === 1) throw new Error("temporary fixture failure");
  });
  await enqueueJob(sqliteDb(db), {
    queue: JOB_KIND.resume,
    payload: { itemId: item.id },
    now: clock.now(),
  });
  await jobs.tick([JOB_KIND.resume]);
  expect(getWorkItem(db, item.id)?.awakeMs).toBe(2 * MINUTE);
  clock.advance(120 * MINUTE);
  expect((await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now())).item.awakeMs).toBe(
    2 * MINUTE,
  );
  await jobs.tick([JOB_KIND.resume]);
  expect(attempts).toBe(2);
  expect(getWorkItem(db, item.id)?.awakeMs).toBe(4 * MINUTE);
  db.close();
});

describe("awake-time cap after Closeout accepted the work", () => {
  test("re-verification after a restart doesn't add awake time", async () => {
    const { clock, db, item } = await acceptedItem(3 * 60 * MINUTE);
    expect(getWorkItem(db, item.id)?.awakeMs).toBe(15 * MINUTE);
    await applyWorkItemEvent(sqliteDb(db), item.id, "reverify_requested");

    expect(await recoverOnStartup(sqliteDb(db), clock.now())).toEqual([{ type: "reverify" }]);
    const restarted = getWorkItem(db, item.id);
    expect(restarted?.state).toBe("verifying");
    expect(restarted?.checkpoint?.phase).toBe("verifying");
    expect((await listJobs(sqliteDb(db))).some((job) => job.queue === "run.reverify")).toBe(true);

    await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now());
    clock.advance(32 * MINUTE);
    const result = await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now());
    expect(result.capped).toBe(false);
    expect(result.item).toMatchObject({
      awakeMs: 15 * MINUTE,
      agentMs: 10 * MINUTE,
      closeoutMs: 5 * MINUTE,
      recheckMs: 32 * MINUTE,
    });
  });

  test("past the cap, accepted work keeps publishing, merging and re-verifying", async () => {
    const { clock, db, item } = await acceptedItem(3 * 60 * MINUTE);
    await configureWorkItem(sqliteDb(db), item.id, { maxAwakeMs: MINUTE });
    clock.advance(4 * 60 * MINUTE);
    expect((await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now())).capped).toBe(
      false,
    );
    expect(getWorkItem(db, item.id)?.state).toBe("merge_queue");

    await applyWorkItemEvent(sqliteDb(db), item.id, "reverify_requested");
    await recoverOnStartup(sqliteDb(db), clock.now());
    clock.advance(60 * MINUTE);
    expect((await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now())).capped).toBe(
      false,
    );

    saveCheckpoint(db, item.id, { phase: "verifying", baseSha: "base", wipCommit: "newer" });
    clock.advance(60 * MINUTE);
    const verifying = await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now());
    expect(verifying.capped).toBe(false);
    expect(verifying.item.state).toBe("verifying");
    expect((await listOutbox(sqliteDb(db))).filter((row) => row.op === "elicitation")).toEqual([]);
  });

  test("a resumed agent at the cap asks in Linear instead of failing", async () => {
    const { clock, db, item, run } = await acceptedItem(30 * MINUTE);
    await applyWorkItemEvent(sqliteDb(db), item.id, "restart", {
      kind: "restart",
      reason: "follow_up",
    });
    await applyWorkItemEvent(sqliteDb(db), item.id, "dispatched");
    saveCheckpoint(db, item.id, { phase: "running", baseSha: "base", wipCommit: "accepted" });
    await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
    clock.advance(20 * MINUTE);

    await enqueueJob(sqliteDb(db), {
      queue: "run.resume",
      payload: { itemId: item.id },
      now: clock.now(),
    });
    await enqueueJob(sqliteDb(db), {
      queue: "github.merge",
      payload: { itemId: item.id },
      now: clock.now(),
    });
    const result = await accrueAwake(
      sqliteDb(db),
      item.id,
      clock.mono(),
      clock.now(),
      undefined,
      true,
    );
    expect(result).toMatchObject({ capped: false, asked: true, stopAgent: true });
    expect(await jobStatuses(db)).toEqual({
      "github.merge": "pending",
      "run.resume": "cancelled",
      "item.ask": "pending",
    });
    expect(result.item).toMatchObject({ state: "running", cancelRequested: false });
    expect(getRun(db, run.id)?.status).toBe("ended");
    const request = (await listJobs(sqliteDb(db))).find((job) => job.queue === "item.ask")?.payload;
    expect(request).toMatchObject({
      kind: "time-limit",
      options: ["Merge the accepted work", "Continue", "Stop"],
      body: expect.stringContaining("Implementation reached its 30 min limit"),
    });
    expect(
      (await listOutbox(sqliteDb(db))).some(
        (row) => (row.payload as { kind?: string }).kind === "error",
      ),
    ).toBe(false);
  });

  test("without an accepted candidate or a session the cap fails and says how the time was spent", async () => {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    legacyMigrate(db);
    const item = insertQueuedItem(db, { maxAwakeMs: 30 * MINUTE, now: 0 });
    db.run("UPDATE work_item SET session_key = NULL WHERE id = ?", [item.id]);
    await beginImplementRun(sqliteDb(db), item.id, clock.now());
    await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
    await applyWorkItemEvent(sqliteDb(db), item.id, "blocking_question");
    clock.advance(90 * MINUTE);
    await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
    await applyWorkItemEvent(sqliteDb(db), item.id, "answer_received");
    clock.advance(30 * MINUTE);
    expect(
      (await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true)).capped,
    ).toBe(true);
    expect((await listOutbox(sqliteDb(db))).at(-1)?.payload).toMatchObject({
      kind: "error",
      body: "Implementation reached its 30 min limit. Counted: implementation 30 min. Not counted: waiting 1 h 30 min.",
    });
  });

  test("verifying with no job working on it is not counted as Closeout time", async () => {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    legacyMigrate(db);
    const item = insertQueuedItem(db, {
      sessionKey: "ses",
      maxAwakeMs: 60 * MINUTE,
      limits: { closeout: 19 * MINUTE },
      now: 0,
    });
    const jobs = new JobLoop(db, clock, { leaseMs: 24 * 60 * MINUTE });
    let finish = () => {};
    let started = () => {};
    jobs.register(
      JOB_KIND.reverify,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
          started();
        }),
    );
    const verify = async () => {
      await enqueueJob(sqliteDb(db), {
        queue: JOB_KIND.reverify,
        payload: { itemId: item.id },
        now: clock.now(),
      });
      const handling = new Promise<void>((resolve) => (started = resolve));
      // The claim is awaited; the handler then holds the job until finish().
      const running = jobs.tick([JOB_KIND.reverify]);
      await handling;
      return { running };
    };
    const accrue = async () =>
      await accrueAwake(
        sqliteDb(db),
        item.id,
        clock.mono(),
        clock.now(),
        undefined,
        getWorkItem(db, item.id)?.state === "running" ? true : undefined,
      );
    await beginImplementRun(sqliteDb(db), item.id, clock.now());
    await accrue();
    clock.advance(41 * MINUTE);
    await accrue();
    await applyWorkItemEvent(sqliteDb(db), item.id, "turn_ended");

    // Two idle hours in verifying, then a job claims the item before the next accrual.
    clock.advance(2 * 60 * MINUTE);
    let { running } = await verify();
    expect(getWorkItem(db, item.id)).toMatchObject({ awakeMs: 41 * MINUTE, closeoutMs: 0 });
    clock.advance(10 * MINUTE);
    await accrue();
    // The job ends between accruals: its last five minutes still count.
    clock.advance(5 * MINUTE);
    finish();
    await running;
    clock.advance(2 * 60 * MINUTE);
    const idle = await accrue();
    expect(idle.capped).toBe(false);
    expect(idle.item).toMatchObject({
      state: "verifying",
      awakeMs: 56 * MINUTE,
      agentMs: 41 * MINUTE,
      closeoutMs: 15 * MINUTE,
    });

    ({ running } = await verify());
    clock.advance(4 * MINUTE);
    expect(await accrue()).toMatchObject({ capped: false, asked: true, stopAgent: true });
    expect(
      (await listJobs(sqliteDb(db))).find((job) => job.queue === "item.ask")?.payload,
    ).toMatchObject({
      body: expect.stringContaining(
        "Counted: implementation 41 min, Closeout 19 min. Not counted: waiting 4 h.",
      ),
    });
    finish();
    await running;
  });

  for (const state of ["running", "recovering"] as const) {
    test(`a ${state} slot wait settles before claim and bills work after claim`, async () => {
      const clock = new FakeClock(20_000);
      const db = openDatabase(":memory:");
      legacyMigrate(db);
      const item = insertQueuedItem(db, { maxAwakeMs: 30 * MINUTE, now: clock.now() });
      const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now());
      if (state === "recovering") await applyWorkItemEvent(sqliteDb(db), item.id, "lease_expired");
      await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now());
      await enqueueJob(sqliteDb(db), {
        queue: JOB_KIND.resume,
        payload: {
          itemId: item.id,
          capacityWait: { since: clock.now(), attempt: 0, runnerIds: ["runner"] },
        },
        now: clock.now(),
      });
      clock.advance(60 * MINUTE);
      const job = (await claimNextJob(sqliteDb(db), {
        now: clock.now(),
        leaseMs: 10 * MINUTE,
        queues: [JOB_KIND.resume],
      }))!;
      await accrueAtJobBoundary(sqliteDb(db), job, "claimed", clock.mono(), clock.now());
      expect(getWorkItem(db, item.id)).toMatchObject({
        state,
        currentRunId: run.id,
        awakeMs: 0,
        waitingMs: 60 * MINUTE,
      });
      clock.advance(2 * MINUTE);
      expect(
        (await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now())).item,
      ).toMatchObject({
        awakeMs: 2 * MINUTE,
        agentMs: 2 * MINUTE,
        waitingMs: 60 * MINUTE,
      });
      db.close();
    });
  }

  async function remoteTurn() {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    legacyMigrate(db);
    const item = insertQueuedItem(db, { sessionKey: "ses", maxAwakeMs: 60 * MINUTE, now: 0 });
    const enqueued = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.start,
      payload: { itemId: item.id },
      now: clock.now(),
    });
    db.run(
      "INSERT INTO scheduler_admission(item_id,job_id,project_key,repository_key,paths,hot,created_at) VALUES(?,?,'*','fixture','[]',0,?)",
      [item.id, enqueued, clock.now()],
    );
    expect(
      await claimNextJob(sqliteDb(db), {
        now: clock.now(),
        leaseMs: 24 * 60 * MINUTE,
        queues: [JOB_KIND.start],
      }),
    ).not.toBeNull();
    const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now());
    db.run("PRAGMA foreign_keys=OFF");
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,'runner','workspace',1,0,'command',?)",
      [run.id, clock.now() + 24 * 60 * MINUTE],
    );
    db.run("PRAGMA foreign_keys=ON");
    await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now());
    const wait = { itemId: item.id, runId: run.id, generation: 1 };
    const accrue = async () => await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now());
    return { clock, db, item, wait, accrue, jobId: enqueued };
  }

  test("an agent waiting 50 minutes on its own command stays under a 60-minute limit", async () => {
    const { clock, db, wait, accrue, jobId } = await remoteTurn();
    clock.advance(9 * MINUTE);
    await startAgentWait(sqliteDb(db), wait, clock.mono(), clock.now());
    for (let minute = 0; minute < 50; minute++) {
      clock.advance(MINUTE);
      if (minute === 20) {
        db.run("UPDATE job SET locked_by='after-restart', attempts=attempts+1 WHERE id=?", [jobId]);
      }
      const outcome = await accrue();
      expect(outcome).toMatchObject({ capped: false });
      expect(outcome.stopAgent).toBeUndefined();
    }
    await endAgentWait(sqliteDb(db), wait, clock.mono(), clock.now(), 50 * MINUTE);
    clock.advance(MINUTE);
    expect((await accrue()).item).toMatchObject({
      state: "running",
      awakeMs: 10 * MINUTE,
      agentMs: 10 * MINUTE,
      implementMs: 10 * MINUTE,
      waitingMs: 50 * MINUTE,
    });
    expect((await listJobs(sqliteDb(db))).some((job) => job.queue === "item.ask")).toBe(false);
    db.close();
  });

  test("a wait delivered late still counts the time the runner measured", async () => {
    const { clock, db, wait, accrue } = await remoteTurn();
    clock.advance(30 * MINUTE);
    await accrue();
    await startAgentWait(sqliteDb(db), wait, clock.mono(), clock.now());
    await endAgentWait(sqliteDb(db), wait, clock.mono(), clock.now(), 28 * MINUTE);
    expect((await accrue()).item).toMatchObject({
      awakeMs: 2 * MINUTE,
      agentMs: 2 * MINUTE,
      implementMs: 2 * MINUTE,
      waitingMs: 28 * MINUTE,
    });
    db.close();
  });

  test("a turn that ends without the runner's end clears the wait", async () => {
    const { clock, db, wait, accrue } = await remoteTurn();
    await startAgentWait(sqliteDb(db), wait, clock.mono(), clock.now());
    clock.advance(10 * MINUTE);
    await endAgentWait(sqliteDb(db), wait, clock.mono(), clock.now());
    clock.advance(5 * MINUTE);
    expect((await accrue()).item).toMatchObject({ agentMs: 5 * MINUTE, waitingMs: 10 * MINUTE });
    db.close();
  });

  test("a Closeout run waiting on CI does not accrue closeout time", async () => {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    legacyMigrate(db);
    const item = insertQueuedItem(db, { sessionKey: "ses", maxAwakeMs: 60 * MINUTE, now: 0 });
    await beginImplementRun(sqliteDb(db), item.id, clock.now());
    await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
    clock.advance(6 * MINUTE);
    await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
    await applyWorkItemEvent(sqliteDb(db), item.id, "turn_ended");
    const job = await verifyingJob(db, item.id, clock.now());
    await markJobAwakeWait(sqliteDb(db), job, true, clock.mono(), clock.now());
    clock.advance(30 * MINUTE);
    const result = await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now());
    expect(result.capped).toBe(false);
    expect(result.item).toMatchObject({
      awakeMs: 6 * MINUTE,
      agentMs: 6 * MINUTE,
      closeoutMs: 0,
      waitingMs: 30 * MINUTE,
    });
    await markJobAwakeWait(sqliteDb(db), job, false, clock.mono(), clock.now());
    clock.advance(2 * MINUTE);
    expect(
      (await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now())).item,
    ).toMatchObject({
      awakeMs: 8 * MINUTE,
      closeoutMs: 2 * MINUTE,
      waitingMs: 30 * MINUTE,
    });
  });

  test("a CI wait clears its pending job and cannot leak into a new claim", async () => {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    legacyMigrate(db);
    const item = insertQueuedItem(db, { now: clock.now() });
    await beginImplementRun(sqliteDb(db), item.id, clock.now());
    await applyWorkItemEvent(sqliteDb(db), item.id, "turn_ended");
    const job = await verifyingJob(db, item.id, clock.now());
    await markJobAwakeWait(sqliteDb(db), job, true, clock.mono(), clock.now());
    await parkLeasedJob(sqliteDb(db), job, {
      now: clock.now(),
      runAt: clock.now(),
      attempts: job.attempts,
      payload: (await getJob(sqliteDb(db), job.id))!.payload,
    });
    await markJobAwakeWait(sqliteDb(db), job, false, clock.mono(), clock.now());
    expect((await getJob(sqliteDb(db), job.id))!.payload).not.toHaveProperty("awakeWait");
    const next = (await claimNextJob(sqliteDb(db), {
      now: clock.now(),
      leaseMs: 60 * MINUTE,
      queues: [JOB_KIND.reverify],
    }))!;
    // A late old writer cannot start a wait for its replacement.
    await markJobAwakeWait(sqliteDb(db), job, true, clock.mono(), clock.now());
    clock.advance(MINUTE);
    expect(
      (await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now())).item.closeoutMs,
    ).toBe(MINUTE);
    await markJobAwakeWait(sqliteDb(db), next, true, clock.mono(), clock.now());
    await markJobAwakeWait(sqliteDb(db), job, false, clock.mono(), clock.now());
    clock.advance(MINUTE);
    expect(
      (await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now())).item,
    ).toMatchObject({
      closeoutMs: MINUTE,
      waitingMs: MINUTE,
    });
    db.close();
  });

  test("an expired CI mark is ignored after reclaim and cannot clear a new owner's wait", async () => {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    legacyMigrate(db);
    const item = insertQueuedItem(db, { now: clock.now() });
    await beginImplementRun(sqliteDb(db), item.id, clock.now());
    await applyWorkItemEvent(sqliteDb(db), item.id, "turn_ended");
    const job = await verifyingJob(db, item.id, clock.now());
    const other = await enqueueJob(sqliteDb(db), {
      queue: "notification",
      payload: { itemId: item.id },
      now: clock.now(),
    });
    db.run("UPDATE job SET status='running', locked_by='other', locked_until=? WHERE id=?", [
      clock.now() + 60 * MINUTE,
      other,
    ]);
    await markJobAwakeWait(sqliteDb(db), job, true, clock.mono(), clock.now());
    expect((await getJob(sqliteDb(db), other))!.payload).not.toHaveProperty("awakeWait");
    db.run("UPDATE job SET locked_until=? WHERE id=?", [clock.now(), job.id]);
    const next = (await claimNextJob(sqliteDb(db), {
      now: clock.now(),
      leaseMs: 60 * MINUTE,
      queues: [JOB_KIND.reverify],
    }))!;
    expect(next).not.toBeNull();
    clock.advance(MINUTE);
    expect(
      (await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now())).item.closeoutMs,
    ).toBe(MINUTE);
    await markJobAwakeWait(sqliteDb(db), next, true, clock.mono(), clock.now());
    await markJobAwakeWait(sqliteDb(db), job, false, clock.mono(), clock.now());
    clock.advance(MINUTE);
    expect(
      (await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now())).item.waitingMs,
    ).toBe(MINUTE);
    db.close();
  });

  test("a task Closeout accepted before the upgrade is still protected after a restart", async () => {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    legacyMigrate(db);
    const item = insertQueuedItem(db, { sessionKey: "ses", maxAwakeMs: 30 * MINUTE, now: 0 });
    await beginImplementRun(sqliteDb(db), item.id, clock.now());
    await applyWorkItemEvent(sqliteDb(db), item.id, "turn_ended");
    await applyWorkItemEvent(sqliteDb(db), item.id, "closeout_accepted");
    saveCheckpoint(db, item.id, { phase: "merge_queue", baseSha: "base", wipCommit: "accepted" });
    for (const column of ["accepted_head", "agent_ms", "closeout_ms", "waiting_ms", "recheck_ms"])
      db.run(`ALTER TABLE work_item DROP COLUMN ${column}`);
    db.run("DELETE FROM schema_migration WHERE id = '117_work_item_awake_breakdown'");
    db.run("UPDATE work_item SET awake_ms = ? WHERE id = ?", [29 * MINUTE, item.id]);

    legacyMigrate(db);
    expect(getWorkItem(db, item.id)?.acceptedHead).toBe("accepted");
    await applyWorkItemEvent(sqliteDb(db), item.id, "reverify_requested");
    await recoverOnStartup(sqliteDb(db), clock.now());
    expect(getWorkItem(db, item.id)?.state).toBe("verifying");
    await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now());
    clock.advance(32 * MINUTE);
    const result = await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now());
    expect(result.capped).toBe(false);
    expect(result.item).toMatchObject({ awakeMs: 29 * MINUTE, recheckMs: 32 * MINUTE });
  });

  test("a task an older Paws already moved back to verifying is protected after the upgrade", async () => {
    const clock = new FakeClock(20_000);
    const db = openDatabase(":memory:");
    legacyMigrate(db);
    const accepted = insertQueuedItem(db, {
      id: "eng-1",
      sessionKey: "a",
      maxAwakeMs: 30 * MINUTE,
      now: 0,
    });
    await beginImplementRun(sqliteDb(db), accepted.id, clock.now());
    await applyWorkItemEvent(sqliteDb(db), accepted.id, "turn_ended");
    await applyWorkItemEvent(sqliteDb(db), accepted.id, "closeout_accepted");
    saveCheckpoint(db, accepted.id, {
      phase: "merge_queue",
      baseSha: "base",
      wipCommit: "accepted",
    });
    db.run("UPDATE work_item SET accepted_head = NULL");
    await applyWorkItemEvent(sqliteDb(db), accepted.id, "reverify_requested");
    await recoverOnStartup(sqliteDb(db), clock.now());
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
    await beginImplementRun(sqliteDb(db), fresh.id, clock.now());
    await applyWorkItemEvent(sqliteDb(db), fresh.id, "turn_ended");
    saveCheckpoint(db, fresh.id, { phase: "verifying", baseSha: "base", wipCommit: "unchecked" });
    for (const column of ["accepted_head", "agent_ms", "closeout_ms", "waiting_ms", "recheck_ms"])
      db.run(`ALTER TABLE work_item DROP COLUMN ${column}`);
    db.run("DELETE FROM schema_migration WHERE id = '117_work_item_awake_breakdown'");
    db.run("UPDATE work_item SET awake_ms = ? WHERE id = ?", [29 * MINUTE, accepted.id]);

    legacyMigrate(db);
    expect(getWorkItem(db, accepted.id)?.acceptedHead).toBe("accepted");
    expect(getWorkItem(db, fresh.id)?.acceptedHead).toBeNull();
    await accrueAwake(sqliteDb(db), accepted.id, clock.mono(), clock.now());
    clock.advance(32 * MINUTE);
    const result = await accrueAwake(sqliteDb(db), accepted.id, clock.mono(), clock.now());
    expect(result.capped).toBe(false);
    expect(result.item).toMatchObject({ awakeMs: 29 * MINUTE, recheckMs: 32 * MINUTE });
  });

  test("without a Linear session, a resumed agent at the cap pauses instead of failing", async () => {
    const { clock, db, item, run } = await acceptedItem(30 * MINUTE);
    db.run("UPDATE work_item SET session_key = NULL WHERE id = ?", [item.id]);
    await applyWorkItemEvent(sqliteDb(db), item.id, "restart", {
      kind: "restart",
      reason: "follow_up",
    });
    await applyWorkItemEvent(sqliteDb(db), item.id, "dispatched");
    await setCurrentRun(sqliteDb(db), item.id, run.id);
    saveCheckpoint(db, item.id, { phase: "running", baseSha: "base", wipCommit: "accepted" });
    await accrueAwake(sqliteDb(db), item.id, clock.mono(), clock.now(), undefined, true);
    clock.advance(20 * MINUTE);
    await enqueueJob(sqliteDb(db), {
      queue: "run.resume",
      payload: { itemId: item.id },
      now: clock.now(),
    });
    await enqueueJob(sqliteDb(db), {
      queue: "github.merge",
      payload: { itemId: item.id },
      now: clock.now(),
    });

    const result = await accrueAwake(
      sqliteDb(db),
      item.id,
      clock.mono(),
      clock.now(),
      undefined,
      true,
    );
    expect(result).toMatchObject({ capped: false, stopAgent: true });
    expect(await jobStatuses(db)).toEqual({ "github.merge": "pending", "run.resume": "cancelled" });
    expect(result.item).toMatchObject({
      state: "paused",
      cancelRequested: false,
      maxAwakeMs: 30 * MINUTE + 60 * MINUTE,
    });
    expect(getRun(db, run.id)?.status).toBe("ended");
    expect(
      (await listOutbox(sqliteDb(db))).some(
        (row) => (row.payload as { kind?: string }).kind === "error",
      ),
    ).toBe(false);
    expect((await listOutbox(sqliteDb(db))).at(-1)?.payload).toMatchObject({
      kind: "thought",
      body: expect.stringMatching(
        /^Paused at the time limit: Implementation reached its 30 min limit\. /,
      ),
    });
  });
});
