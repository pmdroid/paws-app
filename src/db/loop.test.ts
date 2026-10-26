import { cancelOpenJobs } from "./jobs";
import { describe, expect, test } from "bun:test";
import { FakeClock } from "../core";
import {
  enqueueJob,
  JobLoop,
  claimNextJob,
  getJob,
  listJobs,
  migrate,
  openDatabase,
  setJournalSink,
} from "./index";

describe("job loop", () => {
  test("a claimed unknown queue is cancelled once, including recurring jobs", async () => {
    const clock = new FakeClock(1000);
    const db = openDatabase(":memory:");
    migrate(db);
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    try {
      const loop = new JobLoop(db, clock);
      for (const recurringEveryMs of [undefined, 100]) {
        const id = enqueueJob(db, { queue: "removed", recurringEveryMs, now: clock.now() });
        await loop.tick(["removed"]);
        expect(getJob(db, id)).toMatchObject({
          status: "cancelled",
          lastError: "No handler for removed",
          finishedAt: clock.now(),
          lockedBy: null,
          lockedUntil: null,
          attempts: 1,
        });
      }
      clock.advance(100_000);
      expect(await loop.tick(["removed"])).toBeNull();
      expect(lines).toHaveLength(2);
      expect(lines.every((line) => line.includes("removed cancelled: No handler"))).toBe(true);
    } finally {
      restore();
      db.close();
    }
  });

  test("startup removes unknown recurring definitions after handlers are registered", async () => {
    for (const registered of [false, true]) {
      const db = openDatabase(":memory:");
      migrate(db);
      const clock = new FakeClock(1000);
      const removed = enqueueJob(db, { queue: "removed", recurringEveryMs: 100, now: 2000 });
      const oneShot = enqueueJob(db, { queue: "other", now: 2000 });
      const known = registered
        ? enqueueJob(db, { queue: "work", recurringEveryMs: 100, now: 2000 })
        : null;
      const lines: string[] = [];
      const restore = setJournalSink((line) => lines.push(line));
      try {
        const loop = new JobLoop(db, clock);
        if (registered) loop.register("work", () => {});
        const controller = new AbortController();
        controller.abort();
        await loop.run(controller.signal);
        expect(getJob(db, removed)).toBeNull();
        expect(getJob(db, oneShot)?.status).toBe("pending");
        if (known !== null) expect(getJob(db, known)?.status).toBe("pending");
        expect(lines).toEqual([
          `job ${removed} removed recurring definition removed: No handler for removed`,
        ]);
      } finally {
        restore();
        db.close();
      }
    }
  });

  test("polls until a timer row is due", async () => {
    const clock = new FakeClock(0);
    const db = openDatabase(":memory:");
    migrate(db);
    const loop = new JobLoop(db, clock, { pollMs: 100 });
    const handled: string[] = [];
    loop.register("work", (job) => {
      handled.push(job.queue);
    });
    enqueueJob(db, { queue: "later", runAt: 10_000, now: clock.now() });
    enqueueJob(db, { queue: "work", runAt: 500, now: clock.now() });
    const controller = new AbortController();
    let steps = 0;
    await loop.run(controller.signal, async () => {
      clock.advance(100);
      steps += 1;
      if (handled.length > 0 || steps > 20) controller.abort();
    });
    expect(handled).toEqual(["work"]);
    expect(listJobs(db).find((job) => job.queue === "later")?.status).toBe("pending");
  });

  test("a thrown handler is retried and then failed", async () => {
    const clock = new FakeClock(0);
    const db = openDatabase(":memory:");
    migrate(db);
    const loop = new JobLoop(db, clock, { backoffBaseMs: 50 });
    loop.register("work", () => {
      throw new Error("boom");
    });
    enqueueJob(db, { queue: "work", maxAttempts: 2, now: clock.now() });
    await loop.tick();
    expect(listJobs(db)[0]?.status).toBe("pending");
    clock.advance(50);
    await loop.tick();
    expect(listJobs(db)[0]?.status).toBe("dead");
  });
});

for (const scenario of ["reclaimed", "cancelled"] as const) {
  test(`job context aborts a ${scenario} handler without changing its replacement`, async () => {
    const clock = new FakeClock(1000);
    const db = openDatabase(":memory:");
    migrate(db);
    const loop = new JobLoop(db, clock);
    let entered!: () => void;
    const started = new Promise<void>((r) => (entered = r));
    let finish!: () => void;
    const blocked = new Promise<void>((r) => (finish = r));
    let context!: import("./loop").JobContext;
    loop.register("work", async (_job, authority) => {
      context = authority;
      entered();
      await blocked;
      authority.signal.throwIfAborted();
    });
    const id = enqueueJob(db, { queue: "work", payload: { itemId: "item" }, now: clock.now() });
    const running = loop.tick();
    await started;
    if (scenario === "reclaimed") {
      clock.advance(30001);
      expect(
        claimNextJob(db, { workerId: "job-loop", queues: ["work"], now: clock.now() })?.id,
      ).toBe(id);
    } else cancelOpenJobs(db, { itemId: "item", reason: "cancelled", now: clock.now() });
    const replacement = getJob(db, id);
    expect(context.isCurrent()).toBe(false);
    expect(context.signal.aborted).toBe(true);
    expect(context.extendLease()).toBe(false);
    finish();
    await running;
    expect(getJob(db, id)).toEqual(replacement);
    db.close();
  });
}

test("a long handler renews its claim while other workers poll", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(1000);
  const loop = new JobLoop(db, clock, { leaseMs: 90 });
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  let finish!: () => void;
  const blocked = new Promise<void>((r) => (finish = r));
  loop.register("work", async () => {
    entered();
    await blocked;
  });
  const id = enqueueJob(db, { queue: "work", now: clock.now() });
  const running = loop.tick();
  await started;
  for (let i = 0; i < 6; i++) {
    clock.advance(30);
    await Bun.sleep(40);
    expect(claimNextJob(db, { queues: ["work"], now: clock.now() })).toBeNull();
  }
  expect(getJob(db, id)?.attempts).toBe(1);
  finish();
  await running;
  expect(getJob(db, id)?.status).toBe("done");
  db.close();
});

test("a renewal after a pause keeps the job when nobody claimed it in the meantime", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(1000);
  const loop = new JobLoop(db, clock);
  let context!: import("./loop").JobContext;
  let entered!: () => void;
  const started = new Promise<void>((r) => (entered = r));
  let finish!: () => void;
  const blocked = new Promise<void>((r) => (finish = r));
  loop.register("work", async (_job, authority) => {
    context = authority;
    entered();
    await blocked;
    authority.signal.throwIfAborted();
  });
  const id = enqueueJob(db, { queue: "work", now: clock.now() });
  const running = loop.tick();
  await started;
  clock.advance(45_000);
  expect(context.isCurrent()).toBe(true);
  expect(context.extendLease()).toBe(true);
  expect(claimNextJob(db, { workerId: "other", queues: ["work"], now: clock.now() })).toBeNull();
  finish();
  await running;
  expect(getJob(db, id)).toMatchObject({ status: "done", attempts: 1 });
  db.close();
});
