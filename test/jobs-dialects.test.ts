import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { JOB_KIND } from "../src/core";
import {
  refreshVerificationJobVersionSteps,
  replaceLeasedJobPayloadSteps,
  type Db,
  actionableDueSteps,
  cancelAdmittedJobSteps,
  cancelOpenJobsSteps,
  cancelPendingItemJobsSteps,
  claimNextJobSteps,
  completeJobSteps,
  enqueueJobOnceSteps,
  enqueueJobSteps,
  extendJobLeaseSteps,
  failJobSteps,
  getJobSteps,
  hasLiveJobSteps,
  isJobCurrentSteps,
  itemJobRunningSteps,
  jobVersionCurrentSteps,
  latestItemJobIdSteps,
  leasedJobsForItemSteps,
  listJobsSteps,
  nextClaimableRunAtSteps,
  noteJobErrorSteps,
  parkLeasedJobSteps,
  reenqueueJobSteps,
  retryLeasedJobSteps,
  runPendingJobNowSteps,
  type Job,
  type NewJob,
} from "../src/db";
import { forEachDialect, insertWorkItem, type DialectDb } from "./dialects";

async function withDb(open: () => Promise<DialectDb>, body: (db: Db) => Promise<void>) {
  const { db, close } = await open();
  try {
    await body(db);
  } finally {
    await close();
  }
}

const enqueue = (db: Db, job: NewJob) => db.run((q) => enqueueJobSteps(q, job));
const claim = (db: Db, now: number, queues?: string[]) =>
  db.run((q) => claimNextJobSteps(q, { now, queues, leaseMs: 1_000 }));
const getJob = (db: Db, id: number) => db.run((q) => getJobSteps(q, id));

function bumpVersion(db: Db, itemId: string) {
  return db.run(function* (q) {
    yield* q.exec(
      q.orm
        .update(q.t.workItem)
        .set({ version: sql`${q.t.workItem.version} + 1` })
        .where(eq(q.t.workItem.id, itemId)),
    );
  });
}

forEachDialect((open) => {
  test("an enqueued job keeps its payload, defaults and the item's version", async () =>
    withDb(open, async (db) => {
      await insertWorkItem(db, "item");
      const id = await enqueue(db, {
        queue: "work",
        payload: { itemId: "item", nested: { n: 1 }, gone: null },
        now: 100,
      });
      const job = (await getJob(db, id))!;
      expect(job).toMatchObject({
        id,
        queue: "work",
        jobKey: null,
        payload: { itemId: "item", nested: { n: 1 }, gone: null },
        priority: 5,
        runAt: 100,
        status: "pending",
        attempts: 0,
        maxAttempts: 10,
        lockedBy: null,
        createdAt: 100,
        recurringEveryMs: null,
        fireCount: 0,
      });
      expect(await getJob(db, id + 1000)).toBeNull();
      expect(await db.run((q) => jobVersionCurrentSteps(q, job))).toBe(true);
      await bumpVersion(db, "item");
      expect(await db.run((q) => jobVersionCurrentSteps(q, job))).toBe(false);
      expect((await db.run(listJobsSteps)).map((row) => row.id)).toEqual([id]);
    }));

  test("a keyed job is enqueued once, and a finished recurring key is armed again", async () =>
    withDb(open, async (db) => {
      const first = await db.run((q) =>
        enqueueJobOnceSteps(q, { queue: "work", jobKey: "k", now: 0 }),
      );
      expect(first.inserted).toBe(true);
      expect(
        await db.run((q) => enqueueJobOnceSteps(q, { queue: "work", jobKey: "k", now: 0 })),
      ).toEqual({ id: first.id, inserted: false });

      const job = { queue: "tick", jobKey: "tick", payload: { n: 1 }, now: 0 };
      const armed = await db.transaction((q) => reenqueueJobSteps(q, job));
      expect(armed).toEqual({ id: armed.id, pending: true, armed: true });
      expect(await db.transaction((q) => reenqueueJobSteps(q, job))).toEqual({
        id: armed.id,
        pending: true,
        armed: false,
      });
      const claimed = (await claim(db, 0, ["tick"]))!;
      expect(await db.run((q) => completeJobSteps(q, claimed, 10))).toBe(true);
      const again = await db.transaction((q) =>
        reenqueueJobSteps(q, { ...job, now: 20 }, (previous) => ({ n: 2, was: previous?.id })),
      );
      expect(again).toEqual({ id: armed.id, pending: true, armed: true });
      const row = (await getJob(db, armed.id))!;
      expect(row).toMatchObject({ status: "pending", runAt: 20, payload: { n: 2, was: armed.id } });
      expect(row.activationId).not.toBe(claimed.activationId);
      await expect(
        db.transaction((q) => reenqueueJobSteps(q, { ...job, queue: "other" })),
      ).rejects.toThrow("different queue");
    }));

  test("a claim takes due work by priority and leases it", async () =>
    withDb(open, async (db) => {
      const later = await enqueue(db, { queue: "work", priority: 5, now: 0 });
      const first = await enqueue(db, { queue: "work", priority: 1, now: 0 });
      await enqueue(db, { queue: "work", runAt: 5_000, now: 0 });
      await enqueue(db, { queue: "other", now: 0 });
      expect(await db.run((q) => actionableDueSteps(q, 100))).toEqual({
        count: 3,
        oldestRunAt: 0,
      });
      expect(await db.run((q) => nextClaimableRunAtSteps(q, { now: 100, queues: ["work"] }))).toBe(
        0,
      );
      expect(await db.run((q) => nextClaimableRunAtSteps(q, { now: 100, queues: [] }))).toBeNull();
      expect(await claim(db, 100, [])).toBeNull();
      const job = (await claim(db, 100, ["work"]))!;
      expect(job).toMatchObject({ id: first, status: "running", attempts: 1, lockedUntil: 1_100 });
      expect(job.lockedBy).toStartWith("paws:");
      expect((await claim(db, 100, ["work"]))?.id).toBe(later);
      expect(await claim(db, 100, ["work"])).toBeNull();
      expect(await db.run((q) => isJobCurrentSteps(q, job))).toBe(true);
      expect((await claim(db, 1_100, ["work"]))?.id).toBe(first);
      expect(await db.run((q) => isJobCurrentSteps(q, job))).toBe(false);
    }));

  test("a queued start waits for its reservation, and one item holds one lease", async () =>
    withDb(open, async (db) => {
      await insertWorkItem(db, "item");
      const start = await enqueue(db, {
        queue: JOB_KIND.start,
        payload: { itemId: "item" },
        now: 0,
      });
      expect(await claim(db, 10)).toBeNull();
      expect(await db.run((q) => actionableDueSteps(q, 10))).toEqual({
        count: 0,
        oldestRunAt: null,
      });
      await db.run(function* (q) {
        yield* q.exec(
          q.orm.insert(q.t.schedulerAdmission).values({
            itemId: "item",
            jobId: start,
            projectKey: "p",
            repositoryKey: "r",
            paths: (q.dialect === "sqlite" ? "[]" : []) as string[],
            hot: 0,
            createdAt: 0,
          }),
        );
      });
      const reverify = await enqueue(db, {
        queue: JOB_KIND.reverify,
        payload: { itemId: "item" },
        now: 0,
      });
      const started = (await claim(db, 10))!;
      expect(started.id).toBe(start);
      expect(await claim(db, 10)).toBeNull();
      expect(await db.run((q) => hasLiveJobSteps(q, "item", 10))).toBe(true);
      expect(await db.run((q) => hasLiveJobSteps(q, "item", 10, start))).toBe(false);
      expect(await db.run((q) => itemJobRunningSteps(q, JOB_KIND.start, "item"))).toBe(true);
      expect(await db.run((q) => leasedJobsForItemSteps(q, JOB_KIND.start, "item", 10))).toEqual([
        { id: start, attempts: 1, worker: started.lockedBy! },
      ]);
      expect(
        await db.run((q) =>
          latestItemJobIdSteps(q, "item", [JOB_KIND.start, JOB_KIND.reverify], ["pending"]),
        ),
      ).toBe(reverify);
    }));

  test("merge jobs in one lane and repository hold one lease", async () =>
    withDb(open, async (db) => {
      for (const id of ["a", "b"]) {
        await insertWorkItem(db, id);
        await db.run(function* (q) {
          yield* q.exec(
            q.orm.update(q.t.workItem).set({ state: "merge_queue" }).where(eq(q.t.workItem.id, id)),
          );
          yield* q.exec(
            q.orm
              .insert(q.t.mergeQueueEntry)
              .values({ itemId: id, repository: "acme/app", readyAt: 0, lane: "main" }),
          );
          yield* q.exec(
            q.orm
              .insert(q.t.workItemRepository)
              .values({ itemId: id, owner: "Acme", repo: "app", remoteUrl: "x" }),
          );
        });
      }
      await enqueue(db, { queue: JOB_KIND.merge, payload: { itemId: "a" }, now: 0 });
      await enqueue(db, { queue: JOB_KIND.merge, payload: { itemId: "b" }, now: 0 });
      expect((await claim(db, 10))?.payload).toEqual({ itemId: "a" });
      expect(await claim(db, 10)).toBeNull();
      expect(
        await db.run((q) => cancelOpenJobsSteps(q, { reason: "stop", mergeLane: true, now: 20 })),
      ).toBe(2);
      expect((await db.run(listJobsSteps)).map((job) => job.status)).toEqual([
        "cancelled",
        "cancelled",
      ]);
    }));

  test("leased updates succeed only for the lease holder", async () =>
    withDb(open, async (db) => {
      await insertWorkItem(db, "item");
      const id = await enqueue(db, { queue: "work", payload: { itemId: "item" }, now: 0 });
      const job = (await claim(db, 0))!;
      const stranger: Job = { ...job, lockedBy: "someone-else" };
      expect(await db.run((q) => extendJobLeaseSteps(q, stranger, 0, 5_000))).toBe(false);
      expect(await db.run((q) => extendJobLeaseSteps(q, job, 0, 5_000))).toBe(true);
      expect((await getJob(db, id))?.lockedUntil).toBe(5_000);

      expect(
        await db.run((q) => replaceLeasedJobPayloadSteps(q, job, { itemId: "item", w: 1 }, 10)),
      ).toBe(true);
      expect((await getJob(db, id))?.payload).toEqual({ itemId: "item", w: 1 });
      await bumpVersion(db, "item");
      expect(await db.run((q) => refreshVerificationJobVersionSteps(q, job, "run-1", 10))).toBe(
        false,
      );
      await db.run(function* (q) {
        yield* q.exec(
          q.orm
            .update(q.t.workItem)
            .set({ state: "verifying", currentRunId: "run-1" })
            .where(eq(q.t.workItem.id, "item")),
        );
      });
      expect(await db.run((q) => jobVersionCurrentSteps(q, job))).toBe(false);
      expect(await db.run((q) => refreshVerificationJobVersionSteps(q, job, "run-1", 10))).toBe(
        true,
      );
      expect(await db.run((q) => jobVersionCurrentSteps(q, job))).toBe(true);

      const parked = { runAt: 9_000, payload: { itemId: "item", parked: true }, attempts: -2 };
      expect(await db.run((q) => parkLeasedJobSteps(q, job, { ...parked, now: 6_000 }))).toBe(
        false,
      );
      expect(await db.run((q) => parkLeasedJobSteps(q, job, { ...parked, now: 10 }))).toBe(true);
      expect(await getJob(db, id)).toMatchObject({
        status: "pending",
        runAt: 9_000,
        attempts: 0,
        lockedBy: null,
        payload: { itemId: "item", parked: true },
      });
    }));

  test("a parked job keeps an earlier run_at its handler set", async () =>
    withDb(open, async (db) => {
      const id = await enqueue(db, { queue: "work", now: 0 });
      const job = (await claim(db, 0))!;
      await db.run(function* (q) {
        yield* q.exec(q.orm.update(q.t.job).set({ runAt: 500 }).where(eq(q.t.job.id, id)));
      });
      expect(
        await db.run((q) =>
          parkLeasedJobSteps(q, job, { runAt: 9_000, payload: {}, attempts: 1, now: 10 }),
        ),
      ).toBe(true);
      expect((await getJob(db, id))?.runAt).toBe(500);
    }));

  test("a failure retries with backoff, then dies; a recurring job arms its next fire", async () =>
    withDb(open, async (db) => {
      const id = await enqueue(db, { queue: "work", maxAttempts: 2, now: 0 });
      const first = (await claim(db, 0))!;
      const retried = await db.run((q) =>
        failJobSteps(q, first, new Error("boom"), { now: 0, baseMs: 100, capMs: 100 }),
      );
      expect(retried).toMatchObject({ status: "pending", lastError: "boom", attempts: 1 });
      expect(retried!.runAt).toBeGreaterThan(0);
      const second = (await claim(db, retried!.runAt))!;
      expect(await db.run((q) => failJobSteps(q, second, "again", { now: 50_000 }))).toMatchObject({
        status: "dead",
        lastError: "again",
        finishedAt: 50_000,
      });
      expect(await db.run((q) => failJobSteps(q, second, "late", { now: 0 }))).toBeNull();
      await db.run((q) => noteJobErrorSteps(q, id, "noted"));
      expect((await getJob(db, id))?.lastError).toBe("noted");

      const tick = await enqueue(db, { queue: "tick", recurringEveryMs: 1_000, now: 0 });
      const fired = (await claim(db, 0, ["tick"]))!;
      expect(await db.run((q) => completeJobSteps(q, fired, 100))).toBe(true);
      expect(await getJob(db, tick)).toMatchObject({
        status: "pending",
        runAt: 1_100,
        fireCount: 1,
      });
      const retry = (await claim(db, 1_100, ["tick"]))!;
      expect(await db.run((q) => retryLeasedJobSteps(q, retry, 3_000, "later"))).toBe(true);
      expect(await getJob(db, tick)).toMatchObject({ status: "pending", runAt: 3_000 });
    }));

  test("cancellation and run-now touch only the rows they name", async () =>
    withDb(open, async (db) => {
      const pending = await enqueue(db, { queue: "work", payload: { itemId: "a" }, now: 0 });
      const other = await enqueue(db, { queue: "work", payload: { itemId: "b" }, now: 0 });
      const command = await enqueue(db, {
        queue: JOB_KIND.command,
        payload: { itemId: "a" },
        now: 0,
      });
      const future = await enqueue(db, { queue: "later", runAt: 9_000, now: 0 });
      await db.run((q) => runPendingJobNowSteps(q, future, 100));
      expect((await getJob(db, future))?.runAt).toBe(100);
      await db.run((q) => cancelPendingItemJobsSteps(q, "work", "b", 200));
      expect(await getJob(db, other)).toMatchObject({ status: "cancelled", finishedAt: 200 });
      expect(
        await db.run((q) => cancelOpenJobsSteps(q, { reason: "halt", itemId: "a", now: 300 })),
      ).toBe(1);
      expect(await getJob(db, pending)).toMatchObject({ status: "cancelled", lastError: "halt" });
      expect((await getJob(db, command))?.status).toBe("pending");
      expect(await db.run((q) => cancelOpenJobsSteps(q, { reason: "none" }))).toBe(0);
      await db.run((q) => cancelAdmittedJobSteps(q, future, 400));
      expect(await getJob(db, future)).toMatchObject({ status: "cancelled", finishedAt: 400 });
    }));
});
