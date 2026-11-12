import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { and, eq, like, sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import {
  DEFAULT_MAX_AWAKE_MS,
  FakeClock,
  JOB_KIND,
  type Checkpoint,
  type Clock,
  type WorkItemEvent,
} from "../core";
import {
  applyWorkItemEvent as applyEvent,
  beginImplementRun as beginRun,
  beginMergeCall,
  claimNextJob,
  completeJob,
  enqueueJob,
  enterMergeQueue as enterQueue,
  getRun,
  getWorkItem,
  insertQueuedItem,
  JobLoop,
  listJobs as storedJobs,
  listOutbox,
  markCloseoutAccepted,
  prepareShutdown,
  type Db,
  type PgDb,
  type WorkItemEventRecord,
} from "../db";
import { startHost } from "./index";
import { HostSupervisor } from "./supervisor";
import { WakeDetector } from "./wake";
import { tempStore } from "../../test/pglite";

const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function store(): Promise<PgDb> {
  const { db, close } = await tempStore();
  open.push(close);
  return db as PgDb;
}

/** The unit fixture holds a real job while its simulated agent is running. */
async function agentJob(db: Db, itemId: string, now: number) {
  const id = await enqueueJob(db, {
    queue: JOB_KIND.resume,
    jobKey: `fixture-agent:${itemId}:${(await getWorkItem(db, itemId))!.version}`,
    payload: { itemId },
    now,
  });
  await db.run((q) =>
    q.exec(
      q.orm
        .update(q.t.job)
        .set({ status: "running", lockedBy: "fixture", lockedUntil: now + 24 * 60 * 60_000 })
        .where(eq(q.t.job.id, id)),
    ),
  );
}
async function endAgentJob(db: Db, itemId: string) {
  await db.run((q) =>
    q.exec(
      q.orm
        .update(q.t.job)
        .set({ status: "done", lockedUntil: null, lockedBy: null })
        .where(
          and(
            like(q.t.job.jobKey, "fixture-agent:%"),
            sql`${q.t.job.payload}->>'itemId' = ${itemId}`,
          ),
        ),
    ),
  );
}
async function beginImplementRun(db: Db, itemId: string, now: number, checkpoint?: Checkpoint) {
  const result = await beginRun(db, itemId, now, checkpoint);
  await agentJob(db, itemId, now);
  return result;
}
async function applyWorkItemEvent(
  db: Db,
  id: string,
  event: WorkItemEvent,
  record?: WorkItemEventRecord,
) {
  const before = (await getWorkItem(db, id))!.state;
  const result = await applyEvent(db, id, event, record);
  if (before === "running" && result.state !== "running") await endAgentJob(db, id);
  if (before !== "running" && result.state === "running") await agentJob(db, id, 1_000_000);
  return result;
}
async function enterMergeQueue(db: Db, itemId: string, checkpoint: Checkpoint) {
  await endAgentJob(db, itemId);
  return await enterQueue(db, itemId, checkpoint);
}
const listJobs = async (db: Db) =>
  (await storedJobs(db)).filter((job) => !job.jobKey?.startsWith("fixture-agent:"));

const itemWrite = pgTable("item_write", { id: text("id") });

async function wakes(db: Db) {
  const rows = await db.run((q) => q.all(q.orm.select({ ms: q.t.wake.sleptMs }).from(q.t.wake)));
  return rows.map((row) => row.ms);
}

const checkpoint: Checkpoint = { phase: "running", wipCommit: "wip", turn: 3, baseSha: "main" };

async function boot() {
  const clock = new FakeClock(1_000_000);
  const db = await store();
  const host = new HostSupervisor(db, clock, new WakeDetector(clock), 250);
  return { clock, db, host };
}

async function startRun(db: Db, clock: FakeClock, overrides: { maxAwakeMs?: number } = {}) {
  await insertQueuedItem(db, {
    id: "eng-9",
    sessionKey: "linear-session",
    branchName: "paws/eng-9",
    maxAwakeMs: overrides.maxAwakeMs ?? DEFAULT_MAX_AWAKE_MS,
    now: clock.now(),
  });
  return await beginImplementRun(db, "eng-9", clock.now(), checkpoint);
}

/** A job that holds the item's lease, as one does while Closeout verifies it. */
async function verifyingJob(db: Db, clock: FakeClock) {
  await enqueueJob(db, {
    queue: JOB_KIND.reverify,
    payload: { itemId: "eng-9" },
    now: clock.now(),
  });
  return (await claimNextJob(db, {
    now: clock.now(),
    leaseMs: 24 * 60 * 60_000,
    queues: [JOB_KIND.reverify],
  }))!;
}

async function activities(db: Db) {
  return (await listOutbox(db)).filter((message) => message.op === "activity");
}

describe("supervisor accrual writes", () => {
  test("hours in the merge queue do not count as agent time after a review restart", async () => {
    const { clock, db, host } = await boot();
    try {
      await startRun(db, clock);
      await host.tick();
      clock.advance(10 * 60_000);
      await host.tick();
      await applyWorkItemEvent(db, "eng-9", "turn_ended");
      await applyWorkItemEvent(db, "eng-9", "closeout_accepted");
      await markCloseoutAccepted(db, "eng-9", "accepted");
      for (let hour = 0; hour < 4; hour += 1) {
        clock.advance(60 * 60_000);
        await host.tick();
      }
      // A changes-requested review sends the item back; it waits a tick for a runner.
      await applyWorkItemEvent(db, "eng-9", "restart", { kind: "restart", reason: "review" });
      await host.tick();
      await applyWorkItemEvent(db, "eng-9", "dispatched");
      await host.tick();
      clock.advance(5 * 60_000);
      await host.tick();

      expect(await getWorkItem(db, "eng-9")).toMatchObject({
        state: "running",
        agentMs: 15 * 60_000,
        awakeMs: 15 * 60_000,
      });
    } finally {
      host.stop();
    }
  });

  test("only changed awake items are written once per tick", async () => {
    const { clock, db, host } = await boot();
    try {
      for (const id of ["awake", "paused", "idle"]) {
        await insertQueuedItem(db, { id, now: clock.now() });
        if (id !== "idle") await beginImplementRun(db, id, clock.now());
      }
      await applyWorkItemEvent(db, "paused", "pause");
      await db.orm.execute(sql`CREATE TABLE item_write (id text)`);
      await db.orm.execute(
        sql`CREATE FUNCTION count_item_write() RETURNS trigger AS $$ BEGIN INSERT INTO item_write VALUES (NEW.id); RETURN NEW; END $$ LANGUAGE plpgsql`,
      );
      await db.orm.execute(
        sql`CREATE TRIGGER count_item_write AFTER UPDATE ON work_item FOR EACH ROW EXECUTE FUNCTION count_item_write()`,
      );
      const writes = () => db.orm.select().from(itemWrite);

      await host.tick();
      await host.tick();
      expect(await writes()).toEqual([]);
      clock.advance(250);
      await host.tick();
      expect(await writes()).toEqual([{ id: "awake" }]);
      expect(await getWorkItem(db, "awake")).toMatchObject({
        awakeMs: 250,
        agentMs: 250,
      });
      expect(await getWorkItem(db, "paused")).toMatchObject({
        awakeMs: 0,
        lastMonoMs: null,
      });
      expect(await getWorkItem(db, "idle")).toMatchObject({
        awakeMs: 0,
        lastMonoMs: null,
      });
      await host.tick();
      clock.sleep(1_000);
      await host.tick();
      expect(await writes()).toEqual([{ id: "awake" }]);
      clock.advance(250);
      await host.tick();
      expect(await writes()).toEqual([{ id: "awake" }, { id: "awake" }]);

      await applyWorkItemEvent(db, "paused", "resume");
      await db.orm.execute(sql`DELETE FROM item_write`);
      clock.advance(250);
      await host.tick();
      expect(await writes()).toEqual([{ id: "awake" }, { id: "paused" }]);
      expect(await getWorkItem(db, "paused")).toMatchObject({
        awakeMs: 250,
        agentMs: 250,
      });
    } finally {
      host.stop();
    }
  });

  test("all item writes in a tick commit or roll back together", async () => {
    const { clock, db, host } = await boot();
    try {
      for (const id of ["first", "second"]) {
        await insertQueuedItem(db, { id, now: clock.now() });
        await beginImplementRun(db, id, clock.now());
      }
      await host.tick();
      clock.advance(250);
      await db.orm.execute(
        sql`CREATE FUNCTION reject_second() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'tick failed'; END $$ LANGUAGE plpgsql`,
      );
      await db.orm.execute(
        sql`CREATE TRIGGER reject_second BEFORE UPDATE ON work_item FOR EACH ROW WHEN (NEW.id = 'second') EXECUTE FUNCTION reject_second()`,
      );
      const error = (await host.tick().catch((e: unknown) => e)) as Error;
      expect(String(error.cause)).toContain("tick failed");
      expect(await getWorkItem(db, "first")).toMatchObject({
        awakeMs: 0,
        agentMs: 0,
        lastMonoMs: null,
      });
      expect(await getWorkItem(db, "second")).toMatchObject({
        awakeMs: 0,
        agentMs: 0,
        lastMonoMs: null,
      });
      await db.orm.execute(sql`DROP TRIGGER reject_second ON work_item`);
      await host.tick();
      expect(await getWorkItem(db, "first")).toMatchObject({
        awakeMs: 250,
        agentMs: 250,
      });
      expect(await getWorkItem(db, "second")).toMatchObject({
        awakeMs: 250,
        agentMs: 250,
      });
    } finally {
      host.stop();
    }
  });
});

describe("host suspension and clock gaps", () => {
  test("an active run does not acquire a system sleep inhibitor", async () => {
    const { db, close } = await tempStore();
    const clock = new FakeClock(1_000_000);
    await startRun(db, clock);
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("The host must not spawn a sleep inhibitor");
    });
    const controller = new AbortController();
    const host = startHost({ store: db, clock, signal: controller.signal });
    try {
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      host.stop();
      controller.abort();
      spawn.mockRestore();
      await close();
    }
  });
  const TWO_HOURS = 2 * 60 * 60_000;
  const GAPS = [
    ["below two hours", 5 * 60_000],
    ["at two hours", TWO_HOURS],
    ["above two hours", TWO_HOURS + 1],
  ] as const;
  const HELD = [
    "running",
    "accepted",
    "merge_queue",
    "merge_call",
    "paused",
    "awaiting_input",
  ] as const;

  /** Puts eng-9 where `held` names and returns what a clock gap must leave as it is. */
  async function hold(db: Db, clock: FakeClock, held: (typeof HELD)[number]) {
    const { run } = await startRun(db, clock);
    if (held === "paused") await applyWorkItemEvent(db, "eng-9", "pause");
    if (held === "awaiting_input") await applyWorkItemEvent(db, "eng-9", "blocking_question");
    if (held === "accepted") {
      await applyWorkItemEvent(db, "eng-9", "turn_ended");
      await markCloseoutAccepted(db, "eng-9", "wip");
      await verifyingJob(db, clock);
    }
    if (held === "merge_queue" || held === "merge_call") {
      await markCloseoutAccepted(db, "eng-9", "wip");
      await enterMergeQueue(db, "eng-9", { ...checkpoint, phase: "merge_queue" });
      await enqueueJob(db, {
        queue: JOB_KIND.merge,
        payload: { itemId: "eng-9" },
        now: clock.now(),
      });
      await claimNextJob(db, {
        workerId: "merger",
        now: clock.now(),
        queues: [JOB_KIND.merge],
      });
      if (held === "merge_call") await beginMergeCall(db, "eng-9", "wip", clock.now());
    }
    return run;
  }

  async function snapshot(db: Db, runId: string) {
    const item = (await getWorkItem(db, "eng-9"))!;
    return {
      item: {
        state: item.state,
        currentRunId: item.currentRunId,
        checkpoint: item.checkpoint,
        acceptedHead: item.acceptedHead,
        branchName: item.branchName,
        version: item.version,
      },
      run: (await getRun(db, runId))?.status,
      jobs: (await storedJobs(db)).filter((job) => job.queue !== JOB_KIND.catchup),
      mergeCall: await db.run((q) =>
        q.one(q.orm.select().from(q.t.mergeCall).where(eq(q.t.mergeCall.itemId, "eng-9"))),
      ),
    };
  }

  for (const [gapName, gapMs] of GAPS)
    for (const held of HELD)
      test(`a host suspension ${gapName} leaves ${held} work with its owner`, async () => {
        const { clock, db, host } = await boot();
        try {
          const run = await hold(db, clock, held);
          await host.tick();
          const before = await snapshot(db, run.id);

          clock.sleep(gapMs);
          await host.tick();
          await host.tick();

          // No reset, no new implementer, no cancelled job and no rewritten hold.
          expect(await snapshot(db, run.id)).toEqual(before);
          expect(await activities(db)).toEqual([]);
          expect((await listJobs(db)).filter((job) => job.queue === JOB_KIND.catchup)).toHaveLength(
            1,
          );
          expect(await wakes(db)).toEqual([gapMs]);
          if (held === "merge_queue" || held === "merge_call") {
            // The merge job that was working when the host slept still owns the outcome.
            const merge = before.jobs.find((job) => job.queue === JOB_KIND.merge)!;
            expect(await completeJob(db, merge, clock.now())).toBe(true);
          }
        } finally {
          host.stop();
        }
      });

  test("a wall-clock correction is recorded like a suspension and changes no item", async () => {
    const wall = { now: 1_000_000, mono: 1_000_000 };
    const clock: Clock = { now: () => wall.now, mono: () => wall.mono };
    const { db, close } = await tempStore();
    const host = new HostSupervisor(db, clock, new WakeDetector(clock), 250);
    try {
      const { run } = await startRun(db, new FakeClock(wall.now));
      await host.tick();
      const before = await snapshot(db, run.id);
      // NTP steps the wall clock three hours ahead while monotonic time moves one second.
      wall.now += 3 * 60 * 60_000 + 1_000;
      wall.mono += 1_000;
      await host.tick();
      // And back again: a negative gap is no wake at all.
      wall.now -= 3 * 60 * 60_000;
      wall.mono += 1_000;
      await host.tick();
      expect(await snapshot(db, run.id)).toEqual(before);
      expect((await getWorkItem(db, "eng-9"))?.agentMs).toBe(2_000);
      expect(await wakes(db)).toEqual([3 * 60 * 60_000]);
      expect(await activities(db)).toEqual([]);
    } finally {
      host.stop();
      await close();
    }
  });

  test("a process restart is not a clock gap: a new supervisor records no wake", async () => {
    const { clock, db, host } = await boot();
    const { run } = await startRun(db, clock);
    await host.tick();
    host.stop();
    const before = await snapshot(db, run.id);
    clock.sleep(TWO_HOURS + 1);
    const next = new HostSupervisor(db, clock, new WakeDetector(clock), 250);
    await next.tick();
    clock.advance(250);
    await next.tick();
    next.stop();
    expect(await snapshot(db, run.id)).toEqual(before);
    expect(await wakes(db)).toEqual([]);
    expect((await listJobs(db)).filter((job) => job.queue === JOB_KIND.catchup)).toEqual([]);
  });

  test("awake time does not include the sleep, and the cap still trips on awake time", async () => {
    const { clock, db, host } = await boot();
    await startRun(db, clock, { maxAwakeMs: 1_000 });
    await host.tick();
    clock.sleep(30 * 60_000);
    clock.advance(10);
    await host.tick();
    expect(await getWorkItem(db, "eng-9")).toMatchObject({
      state: "running",
      awakeMs: 10,
    });

    clock.advance(990);
    await host.tick();
    expect((await listJobs(db)).some((job) => job.queue === "item.ask")).toBe(true);
  });

  test("the default budget counts implementation only: Closeout time never stops the task", async () => {
    const { clock, db, host } = await boot();
    try {
      await startRun(db, clock);
      await host.tick();
      clock.advance(45 * 60_000);
      await host.tick();
      expect((await getWorkItem(db, "eng-9"))?.state).toBe("running");
      await applyWorkItemEvent(db, "eng-9", "turn_ended");
      await verifyingJob(db, clock);
      clock.advance(4 * 60 * 60_000);
      await host.tick();
      expect(await getWorkItem(db, "eng-9")).toMatchObject({
        state: "verifying",
        implementMs: 45 * 60_000,
        closeoutMs: 4 * 60 * 60_000,
      });
      expect((await listJobs(db)).some((job) => job.queue === "item.ask")).toBe(false);
    } finally {
      host.stop();
    }
  });

  test("verifying with no job working on it is not Closeout time", async () => {
    const { clock, db, host } = await boot();
    const jobs = new JobLoop(db, clock, { leaseMs: 24 * 60 * 60_000 });
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
        payload: { itemId: "eng-9" },
        now: clock.now(),
      });
      const handling = new Promise<void>((resolve) => (started = resolve));
      // The claim is awaited; the handler then holds the job until finish().
      const running = jobs.tick([JOB_KIND.reverify]);
      await handling;
      return { running };
    };
    try {
      await startRun(db, clock);
      await host.tick();
      clock.advance(40 * 60_000);
      await host.tick();
      await applyWorkItemEvent(db, "eng-9", "turn_ended");
      // Two idle hours pass without a tick, then a job claims the item.
      clock.advance(2 * 60 * 60_000);
      const { running } = await verify();
      clock.advance(20 * 60_000);
      await host.tick();
      // The job ends between ticks, and the item sits in verifying for two hours.
      clock.advance(5 * 60_000);
      finish();
      await running;
      clock.advance(2 * 60 * 60_000);
      await host.tick();
      expect(await getWorkItem(db, "eng-9")).toMatchObject({
        state: "verifying",
        awakeMs: 65 * 60_000,
        agentMs: 40 * 60_000,
        closeoutMs: 25 * 60_000,
      });
    } finally {
      host.stop();
    }
  });

  test("parked time is not awake time", async () => {
    const { clock, db, host } = await boot();
    await startRun(db, clock);
    await host.tick();
    await applyWorkItemEvent(db, "eng-9", "blocking_question");
    clock.advance(10_000);
    await host.tick();
    await applyWorkItemEvent(db, "eng-9", "answer_received");
    clock.advance(100);
    await host.tick();
    expect((await getWorkItem(db, "eng-9"))?.awakeMs).toBe(100);
  });

  test("a wake with nothing in flight still enqueues catch-up and no pause note", async () => {
    const { clock, db, host } = await boot();
    await host.tick();
    clock.sleep(5 * 60_000);
    await host.tick();
    expect(await activities(db)).toHaveLength(0);
    expect((await listJobs(db)).filter((job) => job.queue === "linear.catchup")).toHaveLength(1);
  });

  test("SIGTERM commits WIP on the item branch before the run is left recoverable", async () => {
    const { db, clock } = await boot();
    const { run } = await startRun(db, clock);
    const commits: { branchName: string; sha: string }[] = [];
    await prepareShutdown(db, clock.now(), async (item) => {
      expect((await getWorkItem(db, item.id))?.state).toBe("running");
      commits.push({ branchName: item.branchName, sha: "wip-sha" });
    });
    expect(commits).toEqual([{ branchName: "paws/eng-9", sha: "wip-sha" }]);
    expect((await getWorkItem(db, "eng-9"))?.state).toBe("recovering");
    expect((await getRun(db, run.id))?.status).toBe("lost");
  });

  test("stop leaves the item resumable", async () => {
    const { db, clock, host } = await boot();
    await startRun(db, clock);
    await host.tick();
    host.stop();
    clock.advance(100);
    await host.tick();
    expect((await getWorkItem(db, "eng-9"))?.awakeMs).toBe(0);
    await prepareShutdown(db, clock.now());
    expect((await getWorkItem(db, "eng-9"))?.state).toBe("recovering");
    await host.tick();
  });
});

test("the supervisor stops the live agent when the time limit asks instead of failing", async () => {
  const clock = new FakeClock(1_000_000);
  const db = await store();
  const stopped: string[] = [];
  const host = new HostSupervisor(db, clock, new WakeDetector(clock), 250, (itemId) =>
    stopped.push(itemId),
  );
  await insertQueuedItem(db, {
    id: "eng-9",
    sessionKey: "linear-session",
    maxAwakeMs: 1_000,
    now: 0,
  });
  const { run } = await beginImplementRun(db, "eng-9", clock.now(), checkpoint);
  await markCloseoutAccepted(db, "eng-9", "wip");
  await host.tick();
  clock.advance(500);
  await host.tick();
  expect(stopped).toEqual([]);
  clock.advance(600);
  await host.tick();
  expect(stopped).toEqual(["eng-9"]);
  expect((await getWorkItem(db, "eng-9"))?.state).toBe("running");
  expect((await listJobs(db)).filter((job) => job.queue === "item.ask")).toHaveLength(1);
  expect((await getRun(db, run.id))?.status).toBe("ended");
  await host.tick();
  expect(stopped).toEqual(["eng-9"]);
});
