import { describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { FakeClock, JOB_KIND, type Checkpoint, type Clock } from "../src/core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  claimNextJob,
  completeJob,
  deferWorkItem,
  enqueueJob,
  getRun,
  getRunnerSetupHold,
  getWorkItem,
  holdForRunnerSetup,
  insertQueuedItem,
  jobVersionCurrent,
  listJobs,
  listOutbox,
  prepareShutdown,
  recoverOnStartup,
  type Db,
  type Job,
} from "../src/db";
import { HostSupervisor, WakeDetector } from "../src/host";
import { dispatch } from "../src/scheduler";
import { json, seed } from "./dialects";
import { tempStore } from "./pglite";

const TWO_HOURS = 2 * 60 * 60_000;
const GAPS = [
  ["below two hours", 5 * 60_000],
  ["at two hours", TWO_HOURS],
  ["above two hours", TWO_HOURS + 1],
] as const;
const BACKOFF_MS = 10 * 60_000;
const SLOT_POLL_MS = 30_000;
const EXECUTION: readonly string[] = [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify];
const checkpoint: Checkpoint = { phase: "running", wipCommit: "wip", turn: 2, baseSha: "base" };

const WAITS = ["first-start capacity wait", "resume capacity wait", "transient backoff"] as const;
type Wait = (typeof WAITS)[number];

async function boot(clock: Clock & { now(): number } = new FakeClock(1_000_000)) {
  const { db, close } = await tempStore();
  const host = new HostSupervisor(db, clock, new WakeDetector(clock), 250);
  return { db, close, host };
}

async function sleeps(db: Db): Promise<number[]> {
  const rows = await db.run((q) =>
    q.all(q.orm.select({ sleptMs: q.t.wake.sleptMs }).from(q.t.wake)),
  );
  return rows.map((row) => row.sleptMs);
}

function bumpVersion(db: Db, itemId: string): Promise<void> {
  return seed(db, (q) =>
    q.orm
      .update(q.t.workItem)
      .set({ version: sql`${q.t.workItem.version} + 1` })
      .where(eq(q.t.workItem.id, itemId)),
  );
}

async function park(db: Db, now: number, wait: Wait, withCheckpoint: boolean): Promise<number> {
  await insertQueuedItem(db, { id: "eng-9", sessionKey: "linear-session", now });
  const saved = withCheckpoint ? checkpoint : undefined;
  const { item } = await beginImplementRun(db, "eng-9", now, saved);
  if (wait === "transient backoff") {
    await deferWorkItem(db, item, {
      retry: 2,
      delayMs: BACKOFF_MS,
      handoff: "keep going",
      message: null,
      now,
    });
  } else {
    if (wait === "resume capacity wait") await applyWorkItemEvent(db, "eng-9", "lease_expired");
    await enqueueJob(db, {
      queue: wait === "first-start capacity wait" ? JOB_KIND.start : JOB_KIND.resume,
      runAt: now + SLOT_POLL_MS,
      payload: {
        itemId: "eng-9",
        capacityWait: { since: now, attempt: 3, runnerIds: ["busy"] },
      },
      now,
    });
  }
  const [job] = await executions(db);
  return job!.id;
}

async function executions(db: Db, itemId = "eng-9"): Promise<Job[]> {
  return (await listJobs(db)).filter(
    (job) =>
      EXECUTION.includes(job.queue) &&
      (job.status === "pending" || job.status === "running") &&
      (job.payload as { itemId?: string }).itemId === itemId,
  );
}

async function snapshot(db: Db, itemId = "eng-9") {
  const item = (await getWorkItem(db, itemId))!;
  return {
    item: {
      state: item.state,
      version: item.version,
      currentRunId: item.currentRunId,
      checkpoint: item.checkpoint,
      recoveryAttempts: item.recoveryAttempts,
      resumedAt: item.resumedAt,
      awakeMs: item.awakeMs,
      agentMs: item.agentMs,
      cancelRequested: item.cancelRequested,
    },
    run: item.currentRunId === null ? null : (await getRun(db, item.currentRunId))?.status,
    jobs: (await executions(db, itemId)).map(
      ({ id, queue, status, runAt, attempts, maxAttempts, payload }) => ({
        id,
        queue,
        status,
        runAt,
        attempts,
        maxAttempts,
        payload,
      }),
    ),
  };
}

async function activities(db: Db) {
  return (await listOutbox(db)).filter((message) => message.op === "activity");
}

async function observe(db: Db, host: HostSupervisor, now: number): Promise<void> {
  await host.tick();
  await host.tick();
  expect(await dispatch(db, { now })).toEqual([]);
  await dispatch(db, { now });
}

describe("a clock gap during a parked wait", () => {
  for (const wait of WAITS)
    for (const withCheckpoint of [true, false])
      for (const [gapName, gapMs] of GAPS)
        test(`a ${wait} ${withCheckpoint ? "with" : "without"} a checkpoint keeps one owner across a gap ${gapName}`, async () => {
          const clock = new FakeClock(1_000_000);
          const { db, close, host } = await boot(clock);
          try {
            const owner = await park(db, clock.now(), wait, withCheckpoint);
            await host.tick();
            const before = await snapshot(db);

            clock.sleep(gapMs);
            await observe(db, host, clock.now());

            expect(await sleeps(db)).toEqual([gapMs]);
            expect(await snapshot(db)).toEqual(before);
            expect(await activities(db)).toEqual([]);

            const due = before.jobs[0]!.runAt;
            if (due > clock.now()) {
              expect(
                await claimNextJob(db, { now: clock.now(), queues: [...EXECUTION] }),
              ).toBeNull();
              clock.advance(due - clock.now());
              await observe(db, host, clock.now());
            }
            const claimed = await claimNextJob(db, {
              now: clock.now(),
              queues: [...EXECUTION],
            });
            expect(claimed?.id).toBe(owner);
            expect(await jobVersionCurrent(db, claimed!)).toBe(true);
            expect(await claimNextJob(db, { now: clock.now(), queues: [...EXECUTION] })).toBeNull();
            expect(await dispatch(db, { now: clock.now() })).toEqual([]);
            expect((await executions(db)).map((job) => job.id)).toEqual([owner]);
            expect(await completeJob(db, claimed!, clock.now())).toBe(true);
          } finally {
            host.stop();
            await close();
          }
        });

  for (const wait of WAITS)
    for (const withCheckpoint of [true, false])
      test(`a process restart after a gap above two hours leaves a ${wait} ${withCheckpoint ? "with" : "without"} a checkpoint to its job`, async () => {
        const clock = new FakeClock(1_000_000);
        const { db, close, host } = await boot(clock);
        try {
          const owner = await park(db, clock.now(), wait, withCheckpoint);
          await host.tick();
          const before = await snapshot(db);

          await prepareShutdown(db, clock.now());
          host.stop();
          clock.sleep(TWO_HOURS + 1);
          clock.advance(1_000);
          expect(await recoverOnStartup(db, clock.now())).toEqual([]);
          const next = new HostSupervisor(db, clock, new WakeDetector(clock), 250);
          await observe(db, next, clock.now());
          next.stop();

          expect(await sleeps(db)).toEqual([]);
          expect(await snapshot(db)).toEqual(before);
          expect((await claimNextJob(db, { now: clock.now(), queues: [...EXECUTION] }))?.id).toBe(
            owner,
          );
          expect(await claimNextJob(db, { now: clock.now(), queues: [...EXECUTION] })).toBeNull();
        } finally {
          await close();
        }
      });

  for (const wait of WAITS)
    test(`a wall-clock correction forward and back leaves a ${wait} to its job`, async () => {
      const wall = { now: 1_000_000, mono: 1_000_000 };
      const clock: Clock = { now: () => wall.now, mono: () => wall.mono };
      const { db, close, host } = await boot(clock);
      try {
        const owner = await park(db, wall.now, wait, false);
        await host.tick();
        const before = await snapshot(db);

        wall.now += 3 * 60 * 60_000 + 1_000;
        wall.mono += 1_000;
        await observe(db, host, wall.now);
        expect(await snapshot(db)).toEqual(before);

        wall.now -= 3 * 60 * 60_000;
        wall.mono += 1_000;
        await observe(db, host, wall.now);
        expect(await snapshot(db)).toEqual(before);
        expect(await sleeps(db)).toEqual([3 * 60 * 60_000]);
        const due = before.jobs[0]!.runAt;
        expect(await claimNextJob(db, { now: due - 1, queues: [...EXECUTION] })).toBeNull();
        expect((await claimNextJob(db, { now: due, queues: [...EXECUTION] }))?.id).toBe(owner);
        expect(await claimNextJob(db, { now: due, queues: [...EXECUTION] })).toBeNull();
        expect(await activities(db)).toEqual([]);
      } finally {
        host.stop();
        await close();
      }
    });
});

describe("ownership a clock gap does not invent", () => {
  async function abandoned(how: "stale version" | "cancelled" | "another item's job") {
    const clock = new FakeClock(1_000_000);
    const { db, close, host } = await boot(clock);
    const owner = await park(db, clock.now(), "transient backoff", false);
    if (how === "stale version") await bumpVersion(db, "eng-9");
    if (how === "cancelled")
      await seed(db, (q) =>
        q.orm
          .update(q.t.job)
          .set({ status: "cancelled", finishedAt: clock.now() })
          .where(eq(q.t.job.id, owner)),
      );
    if (how === "another item's job") {
      await insertQueuedItem(db, { id: "eng-10", now: clock.now() });
      const job = (await listJobs(db)).find((row) => row.id === owner)!;
      const payload = { ...(job.payload as object), itemId: "eng-10" };
      await seed(db, (q) =>
        q.orm
          .update(q.t.job)
          .set({ payload: json(db, payload) })
          .where(eq(q.t.job.id, owner)),
      );
    }
    await host.tick();
    clock.sleep(TWO_HOURS + 1);
    await host.tick();
    return { clock, db, close, host, owner };
  }

  for (const how of ["stale version", "cancelled", "another item's job"] as const) {
    test(`a ${how} transient retry does not stop startup from resuming abandoned work once`, async () => {
      const { clock, db, close, host, owner } = await abandoned(how);
      try {
        expect(await recoverOnStartup(db, clock.now())).toEqual([
          { type: "resume", freshSession: true, checkpoint: null },
        ]);
        const resumes = (await executions(db)).filter((job) => job.id !== owner);
        expect(resumes).toHaveLength(1);
        expect(await jobVersionCurrent(db, resumes[0]!)).toBe(true);
        expect(await getWorkItem(db, "eng-9")).toMatchObject({
          state: "recovering",
          recoveryAttempts: 1,
        });
        expect(await recoverOnStartup(db, clock.now())).toEqual([{ type: "ask_restart" }]);
      } finally {
        host.stop();
        await close();
      }
    });

    test(`a ${how} transient retry does not keep the orphan sweep from picking the work up`, async () => {
      const { clock, db, close, host, owner } = await abandoned(how);
      try {
        await enqueueJob(db, {
          queue: JOB_KIND.command,
          payload: { itemId: "eng-9" },
          now: 0,
        });
        await seed(db, (q) =>
          q.orm
            .update(q.t.job)
            .set({ status: "done", finishedAt: 0 })
            .where(eq(q.t.job.queue, JOB_KIND.command)),
        );
        expect(await dispatch(db, { now: clock.now() })).toEqual([]);
        await dispatch(db, { now: clock.now() });
        const resumes = (await executions(db)).filter((job) => job.id !== owner);
        expect(resumes).toMatchObject([
          { queue: JOB_KIND.resume, payload: { reason: "orphaned" } },
        ]);
        expect(await jobVersionCurrent(db, resumes[0]!)).toBe(true);
      } finally {
        host.stop();
        await close();
      }
    });
  }

  test("a capacity wait parked at an older item version is not a parked wait at startup", async () => {
    const clock = new FakeClock(1_000_000);
    const { db, close, host } = await boot(clock);
    try {
      await park(db, clock.now(), "first-start capacity wait", true);
      await bumpVersion(db, "eng-9");
      clock.sleep(TWO_HOURS + 1);
      expect(await recoverOnStartup(db, clock.now())).toEqual([
        { type: "resume", freshSession: true, checkpoint },
      ]);
    } finally {
      host.stop();
      await close();
    }
  });
});

describe("repeated clock gaps with holds and parked waits side by side", () => {
  test("holds stay held and waits keep one owner, budget and question across three gaps", async () => {
    const clock = new FakeClock(1_000_000);
    const { db, close, host } = await boot(clock);
    try {
      await park(db, clock.now(), "transient backoff", true);
      await insertQueuedItem(db, { id: "eng-10", sessionKey: "session-10", now: clock.now() });
      await beginImplementRun(db, "eng-10", clock.now());
      await enqueueJob(db, {
        queue: JOB_KIND.start,
        runAt: clock.now() + SLOT_POLL_MS,
        payload: {
          itemId: "eng-10",
          capacityWait: { since: clock.now(), attempt: 0, runnerIds: ["busy"] },
        },
        now: clock.now(),
      });
      await insertQueuedItem(db, { id: "eng-11", sessionKey: "session-11", now: clock.now() });
      await holdForRunnerSetup(db, {
        itemId: "eng-11",
        ownerUserId: null,
        reason: "no-runner",
        now: clock.now(),
      });
      await insertQueuedItem(db, { id: "eng-12", sessionKey: "session-12", now: clock.now() });
      await beginImplementRun(db, "eng-12", clock.now(), checkpoint);
      await applyWorkItemEvent(db, "eng-12", "blocking_question");
      await seed(db, (q) =>
        q.orm
          .update(q.t.workItem)
          .set({ recoveryAttempts: 1 })
          .where(inArray(q.t.workItem.id, ["eng-9", "eng-10"])),
      );

      await host.tick();
      const ids = ["eng-9", "eng-10", "eng-11", "eng-12"];
      const before = [];
      for (const id of ids) before.push(await snapshot(db, id));
      const hold = await getRunnerSetupHold(db, "eng-11");
      const outbox = (await listOutbox(db)).length;

      for (const gapMs of [5 * 60_000, TWO_HOURS, TWO_HOURS + 1]) {
        clock.sleep(gapMs);
        await observe(db, host, clock.now());
        clock.advance(250);
        await host.tick();
      }

      const after = [];
      for (const id of ids) after.push(await snapshot(db, id));
      expect(after).toEqual(before);
      expect(await getRunnerSetupHold(db, "eng-11")).toEqual(hold);
      expect((await getWorkItem(db, "eng-12"))?.state).toBe("awaiting_input");
      expect(await listOutbox(db)).toHaveLength(outbox);
      expect(await sleeps(db)).toHaveLength(3);
      expect((await listJobs(db)).filter((job) => job.queue === JOB_KIND.catchup)).toHaveLength(3);
      expect(await executions(db, "eng-11")).toEqual([]);
      expect(await executions(db, "eng-12")).toEqual([]);
      const claimed: string[] = [];
      for (let job = await claimNextJob(db, { now: clock.now(), queues: [...EXECUTION] }); job;) {
        claimed.push((job.payload as { itemId: string }).itemId);
        job = await claimNextJob(db, { now: clock.now(), queues: [...EXECUTION] });
      }
      expect(claimed.sort()).toEqual(["eng-10", "eng-9"]);
    } finally {
      host.stop();
      await close();
    }
  });
});
