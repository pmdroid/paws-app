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
} from "./index";

describe("job loop", () => {
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
