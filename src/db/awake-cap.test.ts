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
  recoverOnStartup,
  saveCheckpoint,
  setCurrentRun,
  startAgentWait,
  endAgentWait,
  type Db,
} from "./index";
import { eq, sql, type SQL } from "drizzle-orm";
import { seed } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

const MINUTE = 60_000;

const updateItem = (db: Db, id: string, set: { sessionKey: null }) =>
  seed(db, (q) => q.orm.update(q.t.workItem).set(set).where(eq(q.t.workItem.id, id)));

const updateJob = (
  db: Db,
  id: number,
  set: { status?: "running"; lockedBy?: string; lockedUntil?: number; attempts?: SQL },
) => seed(db, (q) => q.orm.update(q.t.job).set(set).where(eq(q.t.job.id, id)));

const admit = (db: Db, itemId: string, jobId: number, now: number) =>
  seed(db, (q) =>
    q.orm.insert(q.t.schedulerAdmission).values({
      itemId,
      jobId,
      projectKey: "*",
      repositoryKey: "fixture",
      paths: [],
      hot: 0,
      createdAt: now,
    }),
  );

const insertRunnerWork = (db: Db, runId: string, leaseUntil: number) =>
  db.transaction(function* (q) {
    yield* q.exec(q.orm.execute(sql`SET LOCAL session_replication_role = replica`));
    yield* q.exec(
      q.orm.insert(q.t.runnerWork).values({
        runId,
        runnerId: "runner",
        workspaceId: "workspace",
        generation: 1,
        runnerFence: 0,
        commandId: "command",
        leaseUntil,
      }),
    );
  });

async function jobStatuses(db: Db): Promise<Record<string, string>> {
  return Object.fromEntries(
    (await listJobs(db))
      .filter((job) => job.status !== "done")
      .map((job) => [job.queue, job.status]),
  );
}

/** Claims a job for the item, as one holds it while Closeout verifies. */
async function verifyingJob(db: Db, itemId: string, now: number) {
  await enqueueJob(db, { queue: JOB_KIND.reverify, payload: { itemId }, now });
  return (await claimNextJob(db, {
    now,
    leaseMs: 24 * 60 * MINUTE,
    queues: [JOB_KIND.reverify],
  }))!;
}

async function acceptedItem(maxAwakeMs: number) {
  const clock = new FakeClock(20_000);
  const db = (await tempStore()).db;
  const item = await insertQueuedItem(db, {
    id: "eng-7",
    sessionKey: "ses",
    maxAwakeMs,
    now: clock.now(),
  });
  const { run } = await beginImplementRun(db, item.id, clock.now());
  await accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
  clock.advance(10 * MINUTE);
  await accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
  await applyWorkItemEvent(db, item.id, "turn_ended");
  const verifying = await verifyingJob(db, item.id, clock.now());
  clock.advance(5 * MINUTE);
  await accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
  await completeJob(db, verifying, clock.now());
  await applyWorkItemEvent(db, item.id, "closeout_accepted");
  await markCloseoutAccepted(db, item.id, "accepted");
  await saveCheckpoint(db, item.id, {
    phase: "merge_queue",
    baseSha: "base",
    wipCommit: "accepted",
  });
  return { clock, db, item, run };
}

test("the job loop bills only active agent and Closeout work across every waiting stage", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(20_000);
  const item = await insertQueuedItem(db, { maxAwakeMs: 30 * MINUTE, now: clock.now() });
  const jobs = new JobLoop(db, clock, { leaseMs: 24 * 60 * MINUTE });
  const accrue = async () => (await accrueAwake(db, item.id, clock.mono(), clock.now())).item;
  await accrue();
  clock.advance(60 * MINUTE);
  expect((await accrue()).awakeMs).toBe(0); // queued
  jobs.register(JOB_KIND.start, async (job) => {
    const { run } = await beginImplementRun(db, item.id, clock.now());
    expect((await accrue()).awakeMs).toBe(0);
    clock.advance(5 * MINUTE);
    expect((await accrue()).awakeMs).toBe(5 * MINUTE);
    await startUsagePause(
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
    expect((await accrue()).awakeMs).toBe(5 * MINUTE);
    await endUsagePause(db, run.id, clock.mono(), clock.now());
    for (const [enter, leave] of [
      ["blocking_question", "answer_received"],
      ["pause", "resume"],
    ] as const) {
      await applyWorkItemEvent(db, item.id, enter);
      clock.advance(60 * MINUTE);
      expect((await accrue()).awakeMs).toBe(5 * MINUTE);
      await applyWorkItemEvent(db, item.id, leave);
    }
    for (const reason of ["runner", "backoff"] as const) {
      await markJobAwakeWait(db, job, true, clock.mono(), clock.now(), reason);
      clock.advance(60 * MINUTE);
      expect((await accrue()).awakeMs).toBe(5 * MINUTE);
      await markJobAwakeWait(db, job, false, clock.mono(), clock.now(), reason);
    }
    clock.advance(3 * MINUTE);
    expect((await accrue()).awakeMs).toBe(8 * MINUTE);
    await applyWorkItemEvent(db, item.id, "turn_ended");
    for (const reason of ["ci", "runner", "backoff"] as const) {
      await markJobAwakeWait(db, job, true, clock.mono(), clock.now(), reason);
      clock.advance(60 * MINUTE);
      expect((await accrue()).awakeMs).toBe(8 * MINUTE);
      await markJobAwakeWait(db, job, false, clock.mono(), clock.now(), reason);
    }
    clock.advance(2 * MINUTE);
    expect(await accrue()).toMatchObject({
      awakeMs: 10 * MINUTE,
      agentMs: 8 * MINUTE,
      closeoutMs: 2 * MINUTE,
    });
    await applyWorkItemEvent(db, item.id, "closeout_accepted");
    clock.advance(60 * MINUTE);
    expect((await accrue()).awakeMs).toBe(10 * MINUTE); // merge queue, even while the job is held
  });
  const id = await enqueueJob(db, {
    queue: JOB_KIND.start,
    payload: { itemId: item.id },
    now: clock.now(),
  });
  await admit(db, item.id, id, clock.now());
  clock.advance(60 * MINUTE); // The claim must settle queued time even without a supervisor tick.
  expect(await jobs.tick([JOB_KIND.start])).not.toBeNull();
  expect(await getWorkItem(db, item.id)).toMatchObject({
    state: "merge_queue",
    awakeMs: 10 * MINUTE,
  });
  await close();
});

test("a live remote turn still counts without a local execution job", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(20_000);
  const item = await insertQueuedItem(db, { maxAwakeMs: 30 * MINUTE, now: clock.now() });
  const { run } = await beginImplementRun(db, item.id, clock.now());
  await insertRunnerWork(db, run.id, clock.now() + 120 * MINUTE);
  await accrueAwake(db, item.id, clock.mono(), clock.now());
  clock.advance(5 * MINUTE);
  expect((await accrueAwake(db, item.id, clock.mono(), clock.now())).item.awakeMs).toBe(5 * MINUTE);
  await seed(db, (q) =>
    q.orm
      .update(q.t.runnerWork)
      .set({ endedAt: clock.now() })
      .where(eq(q.t.runnerWork.runId, run.id)),
  );
  clock.advance(60 * MINUTE);
  expect((await accrueAwake(db, item.id, clock.mono(), clock.now())).item.awakeMs).toBe(5 * MINUTE);
  await close();
});

test("an idle running item and a control job do not spend the awake budget", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(20_000);
  const item = await insertQueuedItem(db, { maxAwakeMs: MINUTE, now: clock.now() });
  await beginImplementRun(db, item.id, clock.now());
  await accrueAwake(db, item.id, clock.mono(), clock.now());
  clock.advance(60 * MINUTE);
  expect((await accrueAwake(db, item.id, clock.mono(), clock.now())).item.awakeMs).toBe(0);
  await enqueueJob(db, {
    queue: "fixture.control",
    payload: { itemId: item.id },
    now: clock.now(),
  });
  await claimNextJob(db, {
    queues: ["fixture.control"],
    now: clock.now(),
    leaseMs: 120 * MINUTE,
  });
  clock.advance(60 * MINUTE);
  expect((await accrueAwake(db, item.id, clock.mono(), clock.now())).item).toMatchObject({
    awakeMs: 0,
    waitingMs: 120 * MINUTE,
  });
  await close();
});

test("a job retry backoff in running counts nothing and work resumes at the next claim", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(20_000);
  const item = await insertQueuedItem(db, { maxAwakeMs: 30 * MINUTE, now: clock.now() });
  await beginImplementRun(db, item.id, clock.now());
  const jobs = new JobLoop(db, clock, { leaseMs: 24 * 60 * MINUTE, backoffBaseMs: 60 * MINUTE });
  let attempts = 0;
  jobs.register(JOB_KIND.resume, () => {
    clock.advance(2 * MINUTE);
    if (++attempts === 1) throw new Error("temporary fixture failure");
  });
  await enqueueJob(db, {
    queue: JOB_KIND.resume,
    payload: { itemId: item.id },
    now: clock.now(),
  });
  await jobs.tick([JOB_KIND.resume]);
  expect((await getWorkItem(db, item.id))?.awakeMs).toBe(2 * MINUTE);
  clock.advance(120 * MINUTE);
  expect((await accrueAwake(db, item.id, clock.mono(), clock.now())).item.awakeMs).toBe(2 * MINUTE);
  await jobs.tick([JOB_KIND.resume]);
  expect(attempts).toBe(2);
  expect((await getWorkItem(db, item.id))?.awakeMs).toBe(4 * MINUTE);
  await close();
});

describe("awake-time cap after Closeout accepted the work", () => {
  test("re-verification after a restart doesn't add awake time", async () => {
    const { clock, db, item } = await acceptedItem(3 * 60 * MINUTE);
    expect((await getWorkItem(db, item.id))?.awakeMs).toBe(15 * MINUTE);
    await applyWorkItemEvent(db, item.id, "reverify_requested");

    expect(await recoverOnStartup(db, clock.now())).toEqual([{ type: "reverify" }]);
    const restarted = await getWorkItem(db, item.id);
    expect(restarted?.state).toBe("verifying");
    expect(restarted?.checkpoint?.phase).toBe("verifying");
    expect((await listJobs(db)).some((job) => job.queue === "run.reverify")).toBe(true);

    await accrueAwake(db, item.id, clock.mono(), clock.now());
    clock.advance(32 * MINUTE);
    const result = await accrueAwake(db, item.id, clock.mono(), clock.now());
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
    await configureWorkItem(db, item.id, { maxAwakeMs: MINUTE });
    clock.advance(4 * 60 * MINUTE);
    expect((await accrueAwake(db, item.id, clock.mono(), clock.now())).capped).toBe(false);
    expect((await getWorkItem(db, item.id))?.state).toBe("merge_queue");

    await applyWorkItemEvent(db, item.id, "reverify_requested");
    await recoverOnStartup(db, clock.now());
    clock.advance(60 * MINUTE);
    expect((await accrueAwake(db, item.id, clock.mono(), clock.now())).capped).toBe(false);

    await saveCheckpoint(db, item.id, {
      phase: "verifying",
      baseSha: "base",
      wipCommit: "newer",
    });
    clock.advance(60 * MINUTE);
    const verifying = await accrueAwake(db, item.id, clock.mono(), clock.now());
    expect(verifying.capped).toBe(false);
    expect(verifying.item.state).toBe("verifying");
    expect((await listOutbox(db)).filter((row) => row.op === "elicitation")).toEqual([]);
  });

  test("a resumed agent at the cap asks in Linear instead of failing", async () => {
    const { clock, db, item, run } = await acceptedItem(30 * MINUTE);
    await applyWorkItemEvent(db, item.id, "restart", {
      kind: "restart",
      reason: "follow_up",
    });
    await applyWorkItemEvent(db, item.id, "dispatched");
    await saveCheckpoint(db, item.id, {
      phase: "running",
      baseSha: "base",
      wipCommit: "accepted",
    });
    await accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
    clock.advance(20 * MINUTE);

    await enqueueJob(db, {
      queue: "run.resume",
      payload: { itemId: item.id },
      now: clock.now(),
    });
    await enqueueJob(db, {
      queue: "github.merge",
      payload: { itemId: item.id },
      now: clock.now(),
    });
    const result = await accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
    expect(result).toMatchObject({ capped: false, asked: true, stopAgent: true });
    expect(await jobStatuses(db)).toEqual({
      "github.merge": "pending",
      "run.resume": "cancelled",
      "item.ask": "pending",
    });
    expect(result.item).toMatchObject({ state: "running", cancelRequested: false });
    expect((await getRun(db, run.id))?.status).toBe("ended");
    const request = (await listJobs(db)).find((job) => job.queue === "item.ask")?.payload;
    expect(request).toMatchObject({
      kind: "time-limit",
      options: ["Merge the accepted work", "Continue", "Stop"],
      body: expect.stringContaining("Implementation reached its 30 min limit"),
    });
    expect(
      (await listOutbox(db)).some((row) => (row.payload as { kind?: string }).kind === "error"),
    ).toBe(false);
  });

  test("without an accepted candidate or a session the cap fails and says how the time was spent", async () => {
    const clock = new FakeClock(20_000);
    const db = (await tempStore()).db;
    const item = await insertQueuedItem(db, { maxAwakeMs: 30 * MINUTE, now: 0 });
    await updateItem(db, item.id, { sessionKey: null });
    await beginImplementRun(db, item.id, clock.now());
    await accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
    await applyWorkItemEvent(db, item.id, "blocking_question");
    clock.advance(90 * MINUTE);
    await accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
    await applyWorkItemEvent(db, item.id, "answer_received");
    clock.advance(30 * MINUTE);
    expect(
      (await accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true)).capped,
    ).toBe(true);
    expect((await listOutbox(db)).at(-1)?.payload).toMatchObject({
      kind: "error",
      body: "Implementation reached its 30 min limit. Counted: implementation 30 min. Not counted: waiting 1 h 30 min.",
    });
  });

  test("verifying with no job working on it is not counted as Closeout time", async () => {
    const clock = new FakeClock(20_000);
    const { db, close } = await tempStore();
    const item = await insertQueuedItem(db, {
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
      await enqueueJob(db, {
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
        db,
        item.id,
        clock.mono(),
        clock.now(),
        undefined,
        (await getWorkItem(db, item.id))?.state === "running" ? true : undefined,
      );
    await beginImplementRun(db, item.id, clock.now());
    await accrue();
    clock.advance(41 * MINUTE);
    await accrue();
    await applyWorkItemEvent(db, item.id, "turn_ended");

    // Two idle hours in verifying, then a job claims the item before the next accrual.
    clock.advance(2 * 60 * MINUTE);
    let { running } = await verify();
    expect(await getWorkItem(db, item.id)).toMatchObject({
      awakeMs: 41 * MINUTE,
      closeoutMs: 0,
    });
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
    expect((await listJobs(db)).find((job) => job.queue === "item.ask")?.payload).toMatchObject({
      body: expect.stringContaining(
        "Counted: implementation 41 min, Closeout 19 min. Not counted: waiting 4 h.",
      ),
    });
    finish();
    await running;
    await close();
  });

  for (const state of ["running", "recovering"] as const) {
    test(`a ${state} slot wait settles before claim and bills work after claim`, async () => {
      const clock = new FakeClock(20_000);
      const { db, close } = await tempStore();
      const item = await insertQueuedItem(db, { maxAwakeMs: 30 * MINUTE, now: clock.now() });
      const { run } = await beginImplementRun(db, item.id, clock.now());
      if (state === "recovering") await applyWorkItemEvent(db, item.id, "lease_expired");
      await accrueAwake(db, item.id, clock.mono(), clock.now());
      await enqueueJob(db, {
        queue: JOB_KIND.resume,
        payload: {
          itemId: item.id,
          capacityWait: { since: clock.now(), attempt: 0, runnerIds: ["runner"] },
        },
        now: clock.now(),
      });
      clock.advance(60 * MINUTE);
      const job = (await claimNextJob(db, {
        now: clock.now(),
        leaseMs: 10 * MINUTE,
        queues: [JOB_KIND.resume],
      }))!;
      await accrueAtJobBoundary(db, job, "claimed", clock.mono(), clock.now());
      expect(await getWorkItem(db, item.id)).toMatchObject({
        state,
        currentRunId: run.id,
        awakeMs: 0,
        waitingMs: 60 * MINUTE,
      });
      clock.advance(2 * MINUTE);
      expect((await accrueAwake(db, item.id, clock.mono(), clock.now())).item).toMatchObject({
        awakeMs: 2 * MINUTE,
        agentMs: 2 * MINUTE,
        waitingMs: 60 * MINUTE,
      });
      await close();
    });
  }

  async function remoteTurn() {
    const clock = new FakeClock(20_000);
    const { db, close } = await tempStore();
    const item = await insertQueuedItem(db, { sessionKey: "ses", maxAwakeMs: 60 * MINUTE, now: 0 });
    const enqueued = await enqueueJob(db, {
      queue: JOB_KIND.start,
      payload: { itemId: item.id },
      now: clock.now(),
    });
    await admit(db, item.id, enqueued, clock.now());
    expect(
      await claimNextJob(db, {
        now: clock.now(),
        leaseMs: 24 * 60 * MINUTE,
        queues: [JOB_KIND.start],
      }),
    ).not.toBeNull();
    const { run } = await beginImplementRun(db, item.id, clock.now());
    await insertRunnerWork(db, run.id, clock.now() + 24 * 60 * MINUTE);
    await accrueAwake(db, item.id, clock.mono(), clock.now());
    const wait = { itemId: item.id, runId: run.id, generation: 1 };
    const accrue = async () => await accrueAwake(db, item.id, clock.mono(), clock.now());
    return { clock, db, close, item, wait, accrue, jobId: enqueued };
  }

  test("an agent waiting 50 minutes on its own command stays under a 60-minute limit", async () => {
    const { clock, db, close, wait, accrue, jobId } = await remoteTurn();
    clock.advance(9 * MINUTE);
    await startAgentWait(db, wait, clock.mono(), clock.now());
    for (let minute = 0; minute < 50; minute++) {
      clock.advance(MINUTE);
      if (minute === 20) {
        await updateJob(db, jobId, { lockedBy: "after-restart", attempts: sql`attempts + 1` });
      }
      const outcome = await accrue();
      expect(outcome).toMatchObject({ capped: false });
      expect(outcome.stopAgent).toBeUndefined();
    }
    await endAgentWait(db, wait, clock.mono(), clock.now(), 50 * MINUTE);
    clock.advance(MINUTE);
    expect((await accrue()).item).toMatchObject({
      state: "running",
      awakeMs: 10 * MINUTE,
      agentMs: 10 * MINUTE,
      implementMs: 10 * MINUTE,
      waitingMs: 50 * MINUTE,
    });
    expect((await listJobs(db)).some((job) => job.queue === "item.ask")).toBe(false);
    await close();
  });

  test("a wait delivered late still counts the time the runner measured", async () => {
    const { clock, db, close, wait, accrue } = await remoteTurn();
    clock.advance(30 * MINUTE);
    await accrue();
    await startAgentWait(db, wait, clock.mono(), clock.now());
    await endAgentWait(db, wait, clock.mono(), clock.now(), 28 * MINUTE);
    expect((await accrue()).item).toMatchObject({
      awakeMs: 2 * MINUTE,
      agentMs: 2 * MINUTE,
      implementMs: 2 * MINUTE,
      waitingMs: 28 * MINUTE,
    });
    await close();
  });

  test("a turn that ends without the runner's end clears the wait", async () => {
    const { clock, db, close, wait, accrue } = await remoteTurn();
    await startAgentWait(db, wait, clock.mono(), clock.now());
    clock.advance(10 * MINUTE);
    await endAgentWait(db, wait, clock.mono(), clock.now());
    clock.advance(5 * MINUTE);
    expect((await accrue()).item).toMatchObject({ agentMs: 5 * MINUTE, waitingMs: 10 * MINUTE });
    await close();
  });

  test("a Closeout run waiting on CI does not accrue closeout time", async () => {
    const clock = new FakeClock(20_000);
    const { db, close } = await tempStore();
    const item = await insertQueuedItem(db, { sessionKey: "ses", maxAwakeMs: 60 * MINUTE, now: 0 });
    await beginImplementRun(db, item.id, clock.now());
    await accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
    clock.advance(6 * MINUTE);
    await accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
    await applyWorkItemEvent(db, item.id, "turn_ended");
    const job = await verifyingJob(db, item.id, clock.now());
    await markJobAwakeWait(db, job, true, clock.mono(), clock.now());
    clock.advance(30 * MINUTE);
    const result = await accrueAwake(db, item.id, clock.mono(), clock.now());
    expect(result.capped).toBe(false);
    expect(result.item).toMatchObject({
      awakeMs: 6 * MINUTE,
      agentMs: 6 * MINUTE,
      closeoutMs: 0,
      waitingMs: 30 * MINUTE,
    });
    await markJobAwakeWait(db, job, false, clock.mono(), clock.now());
    clock.advance(2 * MINUTE);
    expect((await accrueAwake(db, item.id, clock.mono(), clock.now())).item).toMatchObject({
      awakeMs: 8 * MINUTE,
      closeoutMs: 2 * MINUTE,
      waitingMs: 30 * MINUTE,
    });
    await close();
  });

  test("a CI wait clears its pending job and cannot leak into a new claim", async () => {
    const clock = new FakeClock(20_000);
    const { db, close } = await tempStore();
    const item = await insertQueuedItem(db, { now: clock.now() });
    await beginImplementRun(db, item.id, clock.now());
    await applyWorkItemEvent(db, item.id, "turn_ended");
    const job = await verifyingJob(db, item.id, clock.now());
    await markJobAwakeWait(db, job, true, clock.mono(), clock.now());
    await parkLeasedJob(db, job, {
      now: clock.now(),
      runAt: clock.now(),
      attempts: job.attempts,
      payload: (await getJob(db, job.id))!.payload,
    });
    await markJobAwakeWait(db, job, false, clock.mono(), clock.now());
    expect((await getJob(db, job.id))!.payload).not.toHaveProperty("awakeWait");
    const next = (await claimNextJob(db, {
      now: clock.now(),
      leaseMs: 60 * MINUTE,
      queues: [JOB_KIND.reverify],
    }))!;
    // A late old writer cannot start a wait for its replacement.
    await markJobAwakeWait(db, job, true, clock.mono(), clock.now());
    clock.advance(MINUTE);
    expect((await accrueAwake(db, item.id, clock.mono(), clock.now())).item.closeoutMs).toBe(
      MINUTE,
    );
    await markJobAwakeWait(db, next, true, clock.mono(), clock.now());
    await markJobAwakeWait(db, job, false, clock.mono(), clock.now());
    clock.advance(MINUTE);
    expect((await accrueAwake(db, item.id, clock.mono(), clock.now())).item).toMatchObject({
      closeoutMs: MINUTE,
      waitingMs: MINUTE,
    });
    await close();
  });

  test("an expired CI mark is ignored after reclaim and cannot clear a new owner's wait", async () => {
    const clock = new FakeClock(20_000);
    const { db, close } = await tempStore();
    const item = await insertQueuedItem(db, { now: clock.now() });
    await beginImplementRun(db, item.id, clock.now());
    await applyWorkItemEvent(db, item.id, "turn_ended");
    const job = await verifyingJob(db, item.id, clock.now());
    const other = await enqueueJob(db, {
      queue: "notification",
      payload: { itemId: item.id },
      now: clock.now(),
    });
    await updateJob(db, other, {
      status: "running",
      lockedBy: "other",
      lockedUntil: clock.now() + 60 * MINUTE,
    });
    await markJobAwakeWait(db, job, true, clock.mono(), clock.now());
    expect((await getJob(db, other))!.payload).not.toHaveProperty("awakeWait");
    await updateJob(db, job.id, { lockedUntil: clock.now() });
    const next = (await claimNextJob(db, {
      now: clock.now(),
      leaseMs: 60 * MINUTE,
      queues: [JOB_KIND.reverify],
    }))!;
    expect(next).not.toBeNull();
    clock.advance(MINUTE);
    expect((await accrueAwake(db, item.id, clock.mono(), clock.now())).item.closeoutMs).toBe(
      MINUTE,
    );
    await markJobAwakeWait(db, next, true, clock.mono(), clock.now());
    await markJobAwakeWait(db, job, false, clock.mono(), clock.now());
    clock.advance(MINUTE);
    expect((await accrueAwake(db, item.id, clock.mono(), clock.now())).item.waitingMs).toBe(MINUTE);
    await close();
  });

  test("without a Linear session, a resumed agent at the cap pauses instead of failing", async () => {
    const { clock, db, item, run } = await acceptedItem(30 * MINUTE);
    await updateItem(db, item.id, { sessionKey: null });
    await applyWorkItemEvent(db, item.id, "restart", {
      kind: "restart",
      reason: "follow_up",
    });
    await applyWorkItemEvent(db, item.id, "dispatched");
    await setCurrentRun(db, item.id, run.id);
    await saveCheckpoint(db, item.id, {
      phase: "running",
      baseSha: "base",
      wipCommit: "accepted",
    });
    await accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
    clock.advance(20 * MINUTE);
    await enqueueJob(db, {
      queue: "run.resume",
      payload: { itemId: item.id },
      now: clock.now(),
    });
    await enqueueJob(db, {
      queue: "github.merge",
      payload: { itemId: item.id },
      now: clock.now(),
    });

    const result = await accrueAwake(db, item.id, clock.mono(), clock.now(), undefined, true);
    expect(result).toMatchObject({ capped: false, stopAgent: true });
    expect(await jobStatuses(db)).toEqual({ "github.merge": "pending", "run.resume": "cancelled" });
    expect(result.item).toMatchObject({
      state: "paused",
      cancelRequested: false,
      maxAwakeMs: 30 * MINUTE + 60 * MINUTE,
    });
    expect((await getRun(db, run.id))?.status).toBe("ended");
    expect(
      (await listOutbox(db)).some((row) => (row.payload as { kind?: string }).kind === "error"),
    ).toBe(false);
    expect((await listOutbox(db)).at(-1)?.payload).toMatchObject({
      kind: "thought",
      body: expect.stringMatching(
        /^Paused at the time limit: Implementation reached its 30 min limit\. /,
      ),
    });
  });
});
