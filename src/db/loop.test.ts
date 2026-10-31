import { cancelOpenJobs } from "./jobs";
import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { FakeClock, systemClock } from "../core";
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

/** The next claim statement throws once. Later claims use the real database. */
function failNextClaim(db: Database): { db: Database; failNext(): void } {
  let fail = false;
  const wrapped = new Proxy(db, {
    get(target, property, receiver) {
      if (property === "query") {
        return (sql: string) => {
          const statement = target.query(sql);
          if (!fail || !sql.startsWith("UPDATE job SET status = 'running'")) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty === "get") {
                return () => {
                  fail = false;
                  throw new Error("SQLITE_BUSY: database is locked");
                };
              }
              const value = Reflect.get(statementTarget, statementProperty, statementReceiver);
              return typeof value === "function" ? value.bind(statementTarget) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    db: wrapped,
    failNext() {
      fail = true;
    },
  };
}

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

test("an idle loop claims once per ceiling and sleeps until the earliest run_at", async () => {
  const clock = new FakeClock(0);
  const db = openDatabase(":memory:");
  migrate(db);
  const seen: number[] = [];
  const claims: number[] = [];
  const observed = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return (sql: string) => {
          if (sql.startsWith("UPDATE job SET status = 'running'")) claims.push(clock.now());
          return target.query(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const loop = new JobLoop(observed as typeof db, clock, { pollMs: 1_000 });
  loop.register("work", () => {
    seen.push(clock.now());
  });
  enqueueJob(db, { queue: "work", runAt: 2_500, now: 0 });
  const requested: number[] = [];
  const controller = new AbortController();
  await loop.run(controller.signal, async (ms) => {
    requested.push(ms);
    clock.advance(ms);
    if (seen.length > 0 || requested.length > 4) controller.abort();
  });
  expect(seen).toEqual([2_500]);
  // One claim at the start of each idle second, then a claim when the job is due.
  expect(claims.filter((at) => at < 2_500)).toEqual([0, 1_000, 2_000]);
  expect(requested.slice(0, 3)).toEqual([1_000, 1_000, 500]);
  expect(claims).toContain(2_500);
  db.close();
});

test("a job enqueued while the loop sleeps starts within 50ms", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const loop = new JobLoop(db, systemClock, { pollMs: 60_000 });
  let startedAt = 0;
  loop.register("work", () => {
    startedAt = Date.now();
  });
  const controller = new AbortController();
  const running = loop.run(controller.signal);
  await Bun.sleep(20);
  const enqueuedAt = Date.now();
  enqueueJob(db, { queue: "work", now: enqueuedAt });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (startedAt !== 0) break;
    await Bun.sleep(1);
  }
  expect(startedAt).toBeGreaterThan(0);
  expect(startedAt - enqueuedAt).toBeLessThan(50);
  controller.abort();
  await running;
  db.close();
});

test("a claim failure keeps the worker polling and runs the job once", async () => {
  const clock = new FakeClock(1_000);
  const real = openDatabase(":memory:");
  migrate(real);
  const gate = failNextClaim(real);
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  const loop = new JobLoop(gate.db, clock, { pollMs: 10 });
  let runs = 0;
  loop.register("work", () => {
    runs += 1;
  });
  const id = enqueueJob(real, { queue: "work", now: clock.now() });
  gate.failNext();
  const controller = new AbortController();
  let polls = 0;
  try {
    await loop.run(controller.signal, async () => {
      polls += 1;
      if (runs > 0 || polls > 5) controller.abort();
    });
    expect(lines.join("\n")).toContain("operation=loop.tick.claimNextJob");
    expect(lines.join("\n")).toContain("SQLITE_BUSY");
    expect(runs).toBe(1);
    expect(polls).toBeGreaterThan(0);
    expect(getJob(real, id)).toMatchObject({ status: "done", attempts: 1 });
    expect(loop.liveness()).toMatchObject({ polling: true, inFlight: 0, workerCount: 1 });
  } finally {
    restore();
    real.close();
  }
});

test("a claim failure does not cancel or repeat an in-flight handler", async () => {
  const clock = new FakeClock(1_000);
  const real = openDatabase(":memory:");
  migrate(real);
  const gate = failNextClaim(real);
  const loop = new JobLoop(gate.db, clock);
  let runs = 0;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve));
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => (finish = resolve));
  let context!: import("./loop").JobContext;
  loop.register("work", async (_job, authority) => {
    runs += 1;
    context = authority;
    entered();
    await blocked;
    authority.signal.throwIfAborted();
  });
  const runningId = enqueueJob(real, { queue: "work", now: clock.now() });
  const running = loop.tick();
  await started;
  expect(loop.liveness().inFlight).toBe(1);
  const waitingId = enqueueJob(real, { queue: "work", now: clock.now() });
  gate.failNext();
  expect(await loop.tick()).toBeNull();
  expect(context.signal.aborted).toBe(false);
  expect(getJob(real, runningId)).toMatchObject({ status: "running", attempts: 1 });
  expect(getJob(real, waitingId)).toMatchObject({ status: "pending", attempts: 0 });
  expect(loop.liveness().inFlight).toBe(1);
  finish();
  await running;
  expect(runs).toBe(1);
  expect(getJob(real, runningId)).toMatchObject({ status: "done", attempts: 1 });
  await loop.tick();
  expect(getJob(real, waitingId)).toMatchObject({ status: "done", attempts: 1 });
  real.close();
});
