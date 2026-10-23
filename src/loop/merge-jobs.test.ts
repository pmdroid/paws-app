import { describe, expect, test } from "bun:test";
import { FakeClock, JOB_KIND, MERGE_LANE } from "../core";
import {
  JobLoop,
  bindWorkItemRepository,
  claimNextJob,
  completeJob,
  enqueueJob,
  getJob,
  insertQueuedItem,
  migrate,
  openDatabase,
} from "../db";
import {
  MERGE_CI_POLL_MS,
  MERGE_CI_WAIT_MS,
  ciWaitVerification,
  parkMergeForCi,
  retryMergeLater,
  waitForMergeTurn,
} from "./merge-jobs";

function queue() {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(1_000);
  return { db, clock };
}

describe("merge CI wait", () => {
  test("a parked merge remembers what it waits for, for the Merge queue page", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
    let reason: "review" | "ci" = "review";
    loop.register(JOB_KIND.merge, (job) => {
      parkMergeForCi(db, job, clock.now(), undefined, {
        queued: reason === "review",
        reason,
        message: reason === "review" ? "Waiting for an approving review." : "CI 4 of 6 done.",
      });
    });
    const ran = await loop.tick();
    expect(getJob(db, ran!.id)?.payload).toMatchObject({
      mergeWait: { reason: "review", message: "Waiting for an approving review." },
    });
    reason = "ci";
    clock.advance(60_000);
    await loop.tick();
    expect(getJob(db, ran!.id)?.payload).toMatchObject({
      mergeWait: { reason: "ci", message: "CI 4 of 6 done." },
    });
  });

  test("a merge whose CI is still pending does not keep a running job", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    insertQueuedItem(db, { id: "eng-2", now: clock.now() });
    bindWorkItemRepository(db, "eng-1", {
      owner: "acme",
      repo: "one",
      remoteUrl: "https://github.com/acme/one.git",
    });
    bindWorkItemRepository(db, "eng-2", {
      owner: "acme",
      repo: "one",
      remoteUrl: "https://github.com/acme/one.git",
    });
    enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-2" },
      now: clock.now(),
    });
    const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
    loop.register(JOB_KIND.merge, (job) => {
      expect(parkMergeForCi(db, job, clock.now())).toBe("parked");
    });
    const ran = await loop.tick();
    const parked = ran === null ? null : getJob(db, ran.id);
    expect(parked?.status).toBe("pending");
    expect(parked?.lockedBy).toBeNull();
    expect(parked?.attempts).toBe(0);
    expect(parked?.runAt).toBe(clock.now() + MERGE_CI_POLL_MS);
    expect(parked?.payload).toMatchObject({
      itemId: "eng-1",
      ciWaitDeadline: clock.now() + MERGE_CI_WAIT_MS,
    });
    const other = claimNextJob(db, {
      workerId: "worker",
      leaseMs: 60_000,
      now: clock.now(),
      queues: [JOB_KIND.merge],
    });
    expect(other?.payload).toEqual({ itemId: "eng-2" });
    expect(other?.status).toBe("running");
    clock.advance(MERGE_CI_POLL_MS);
    expect(
      claimNextJob(db, {
        workerId: "worker",
        leaseMs: 60_000,
        now: clock.now(),
        queues: [JOB_KIND.merge],
      }),
    ).toBeNull();
    if (other === null) throw new Error("missing claim");
    expect(completeJob(db, other, clock.now())).toBe(true);
    expect(claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.merge] })?.payload).toMatchObject(
      { itemId: "eng-1" },
    );
  });

  test("a merge CI wait expires instead of parking past the limit", () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    bindWorkItemRepository(db, "eng-1", {
      owner: "acme",
      repo: "one",
      remoteUrl: "https://github.com/acme/one.git",
    });
    enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    const first = claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.merge] });
    if (first === null) throw new Error("missing claim");
    expect(parkMergeForCi(db, first, clock.now())).toBe("parked");
    clock.advance(MERGE_CI_WAIT_MS);
    const again = claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.merge] });
    if (again === null) throw new Error("missing claim");
    expect(again.id).toBe(first.id);
    expect(parkMergeForCi(db, again, clock.now())).toBe("expired");
    expect(getJob(db, first.id)?.status).toBe("running");
  });

  test("a reclaimed merge job keeps the verified base, head, and summary", () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    bindWorkItemRepository(db, "eng-1", {
      owner: "acme",
      repo: "one",
      remoteUrl: "https://github.com/acme/one.git",
    });
    enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    const first = claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.merge] });
    if (first === null) throw new Error("missing claim");
    expect(
      parkMergeForCi(db, first, clock.now(), {
        base: "base-sha",
        head: "head-sha",
        summary: "accepted once",
      }),
    ).toBe("parked");
    clock.advance(MERGE_CI_POLL_MS);
    const again = claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.merge] });
    expect(again?.id).toBe(first.id);
    expect(ciWaitVerification(again?.payload)).toEqual({
      base: "base-sha",
      head: "head-sha",
      summary: "accepted once",
    });
  });
});

describe("merge job retries", () => {
  test("waiting for the task's other job does not spend an attempt", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    const id = enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-1", head: "head-sha" },
      maxAttempts: 2,
      now: clock.now(),
    });
    const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
    loop.register(JOB_KIND.merge, (job) => {
      waitForMergeTurn(db, job, clock.now());
    });
    for (let pass = 0; pass < 5; pass++) {
      await loop.tick();
      clock.advance(10_000);
    }
    expect(getJob(db, id)).toMatchObject({
      status: "pending",
      attempts: 0,
      payload: { itemId: "eng-1", head: "head-sha" },
    });
  });

  test("a failed attempt waits for its backoff and keeps the attempt spent", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    const id = enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
    loop.register(JOB_KIND.merge, (job) => {
      retryMergeLater(db, job, clock.now(), 30_000, new Error("GitHub returned 502"));
    });
    await loop.tick();
    expect(getJob(db, id)).toMatchObject({
      status: "pending",
      attempts: 1,
      runAt: clock.now() + 30_000,
      lastError: "GitHub returned 502",
    });
    clock.advance(29_000);
    expect(await loop.tick()).toBeNull();
  });
});
