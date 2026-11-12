import { cancelOpenJobs } from "./jobs";
import { describe, expect, test } from "bun:test";
import { FakeClock, systemClock } from "../core";
import { sampleHostOperations } from "../host-operation";
import {
  enqueueJob,
  JobLoop,
  claimNextJob,
  getJob,
  listJobs,
  setJournalSink,
  type Db,
  type Q,
  type Steps,
} from "./index";
import { tempStore } from "../../test/pglite";

const CLAIM_SQL = 'update "job" set "status" = $1, "attempts" = "job"."attempts" + 1';

function onClaim(db: Db, hook: () => void): Db {
  const watch = <T>(body: (q: Q) => Steps<T>) =>
    function* (q: Q): Steps<T> {
      const steps = body(q);
      let next = steps.next();
      while (!next.done) {
        const step = next.value;
        const query = "query" in step ? (step.query as { toSQL?(): { sql: string } }) : {};
        if (query.toSQL?.().sql.startsWith(CLAIM_SQL)) hook();
        let value: unknown;
        try {
          value = yield step;
        } catch (error) {
          next = steps.throw(error);
          continue;
        }
        next = steps.next(value);
      }
      return next.value;
    };
  return { ...db, run: (body) => db.run(watch(body)) } as Db;
}

function failNextClaim(db: Db): { db: Db; failNext(): void } {
  let fail = false;
  return {
    db: onClaim(db, () => {
      if (!fail) return;
      fail = false;
      throw new Error("database is locked");
    }),
    failNext() {
      fail = true;
    },
  };
}

describe("job loop", () => {
  test("a claimed unknown queue is cancelled once, including recurring jobs", async () => {
    const clock = new FakeClock(1000);
    const { db, close } = await tempStore();
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    try {
      const loop = new JobLoop(db, clock);
      for (const recurringEveryMs of [undefined, 100]) {
        const id = await enqueueJob(db, {
          queue: "removed",
          recurringEveryMs,
          now: clock.now(),
        });
        await loop.tick(["removed"]);
        expect(await getJob(db, id)).toMatchObject({
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
      await close();
    }
  });

  test("startup removes unknown recurring definitions after handlers are registered", async () => {
    for (const registered of [false, true]) {
      const { db, close } = await tempStore();
      const clock = new FakeClock(1000);
      const removed = await enqueueJob(db, {
        queue: "removed",
        recurringEveryMs: 100,
        now: 2000,
      });
      const oneShot = await enqueueJob(db, { queue: "other", now: 2000 });
      const known = registered
        ? await enqueueJob(db, { queue: "work", recurringEveryMs: 100, now: 2000 })
        : null;
      const lines: string[] = [];
      const restore = setJournalSink((line) => lines.push(line));
      try {
        const loop = new JobLoop(db, clock);
        if (registered) loop.register("work", () => {});
        const controller = new AbortController();
        controller.abort();
        await loop.run(controller.signal);
        expect(await getJob(db, removed)).toBeNull();
        expect((await getJob(db, oneShot))?.status).toBe("pending");
        if (known !== null) expect((await getJob(db, known))?.status).toBe("pending");
        expect(lines).toEqual([
          `job ${removed} removed recurring definition removed: No handler for removed`,
        ]);
      } finally {
        restore();
        await close();
      }
    }
  });

  test("polls until a timer row is due", async () => {
    const clock = new FakeClock(0);
    const db = (await tempStore()).db;
    const loop = new JobLoop(db, clock, { pollMs: 100 });
    const handled: string[] = [];
    loop.register("work", (job) => {
      handled.push(job.queue);
    });
    await enqueueJob(db, { queue: "later", runAt: 10_000, now: clock.now() });
    await enqueueJob(db, { queue: "work", runAt: 500, now: clock.now() });
    const controller = new AbortController();
    let steps = 0;
    await loop.run(controller.signal, async () => {
      clock.advance(100);
      steps += 1;
      if (handled.length > 0 || steps > 20) controller.abort();
    });
    expect(handled).toEqual(["work"]);
    expect((await listJobs(db)).find((job) => job.queue === "later")?.status).toBe("pending");
  });

  test("a thrown handler is retried and then failed", async () => {
    const clock = new FakeClock(0);
    const db = (await tempStore()).db;
    const loop = new JobLoop(db, clock, { backoffBaseMs: 50 });
    loop.register("work", () => {
      throw new Error("boom");
    });
    await enqueueJob(db, { queue: "work", maxAttempts: 2, now: clock.now() });
    await loop.tick();
    expect((await listJobs(db))[0]?.status).toBe("pending");
    clock.advance(50);
    await loop.tick();
    expect((await listJobs(db))[0]?.status).toBe("dead");
  });
});

for (const scenario of ["reclaimed", "cancelled"] as const) {
  test(`job context aborts a ${scenario} handler without changing its replacement`, async () => {
    const clock = new FakeClock(1000);
    const { db, close } = await tempStore();
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
    const id = await enqueueJob(db, {
      queue: "work",
      payload: { itemId: "item" },
      now: clock.now(),
    });
    const running = loop.tick();
    await started;
    if (scenario === "reclaimed") {
      clock.advance(30001);
      expect(
        (
          await claimNextJob(db, {
            workerId: "job-loop",
            queues: ["work"],
            now: clock.now(),
          })
        )?.id,
      ).toBe(id);
    } else await cancelOpenJobs(db, { itemId: "item", reason: "cancelled", now: clock.now() });
    const replacement = await getJob(db, id);
    expect(await context.isCurrent()).toBe(false);
    expect(context.signal.aborted).toBe(true);
    expect(await context.extendLease()).toBe(false);
    finish();
    await running;
    expect(await getJob(db, id)).toEqual(replacement);
    await close();
  });
}

test("a long handler renews its claim while other workers poll", async () => {
  const { db, close } = await tempStore();
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
  const id = await enqueueJob(db, { queue: "work", now: clock.now() });
  const running = loop.tick();
  await started;
  for (let i = 0; i < 6; i++) {
    clock.advance(30);
    await Bun.sleep(40);
    expect(await claimNextJob(db, { queues: ["work"], now: clock.now() })).toBeNull();
  }
  expect((await getJob(db, id))?.attempts).toBe(1);
  finish();
  await running;
  expect((await getJob(db, id))?.status).toBe("done");
  await close();
});

test("a renewal after a pause keeps the job when nobody claimed it in the meantime", async () => {
  const { db, close } = await tempStore();
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
  const id = await enqueueJob(db, { queue: "work", now: clock.now() });
  const running = loop.tick();
  await started;
  clock.advance(45_000);
  expect(await context.isCurrent()).toBe(true);
  expect(await context.extendLease()).toBe(true);
  expect(
    await claimNextJob(db, { workerId: "other", queues: ["work"], now: clock.now() }),
  ).toBeNull();
  finish();
  await running;
  expect(await getJob(db, id)).toMatchObject({ status: "done", attempts: 1 });
  await close();
});

test("an idle loop claims once per ceiling and sleeps until the earliest run_at", async () => {
  const clock = new FakeClock(0);
  const { db, close } = await tempStore();
  const seen: number[] = [];
  const claims: number[] = [];
  const observed = onClaim(db, () => claims.push(clock.now()));
  const loop = new JobLoop(observed, clock, { pollMs: 1_000 });
  loop.register("work", () => {
    seen.push(clock.now());
  });
  await enqueueJob(db, { queue: "work", runAt: 2_500, now: 0 });
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
  await close();
});

test("a job enqueued after the loop read its next run time wakes it before the poll", async () => {
  const { db, close } = await tempStore();
  let armed = true;
  const store = {
    ...db,
    run: async <T>(body: (q: Q) => Steps<T>) => {
      let readNextRunAt = false;
      const result = await db.run(function* (q: Q): Steps<T> {
        const steps = body(q);
        let next = steps.next();
        while (!next.done) {
          const step = next.value;
          const query = "query" in step ? (step.query as { toSQL?(): { sql: string } }) : {};
          if (query.toSQL?.().sql.includes("MIN(")) readNextRunAt = true;
          next = steps.next(yield step);
        }
        return next.value;
      });
      if (readNextRunAt && armed) {
        armed = false;
        await enqueueJob(db, { queue: "work", now: Date.now() });
      }
      return result;
    },
  } as Db;
  const loop = new JobLoop(db, systemClock, { pollMs: 60_000, store });
  let started = false;
  loop.register("work", () => {
    started = true;
  });
  const controller = new AbortController();
  const running = loop.run(controller.signal);
  for (let attempt = 0; attempt < 200; attempt++) {
    if (started) break;
    await Bun.sleep(5);
  }
  expect(armed).toBe(false);
  expect(started).toBe(true);
  controller.abort();
  await running;
  await close();
});

test("a job enqueued while the loop sleeps starts within 50ms", async () => {
  const { db, close } = await tempStore();
  const loop = new JobLoop(db, systemClock, { pollMs: 60_000 });
  let startedAt = 0;
  loop.register("work", () => {
    startedAt = Date.now();
  });
  const controller = new AbortController();
  const running = loop.run(controller.signal);
  await Bun.sleep(20);
  const enqueuedAt = Date.now();
  await enqueueJob(db, { queue: "work", now: enqueuedAt });
  for (let attempt = 0; attempt < 40; attempt++) {
    if (startedAt !== 0) break;
    await Bun.sleep(1);
  }
  expect(startedAt).toBeGreaterThan(0);
  expect(startedAt - enqueuedAt).toBeLessThan(50);
  controller.abort();
  await running;
  await close();
});

test("a claim failure keeps the worker polling and runs the job once", async () => {
  const clock = new FakeClock(1_000);
  const { db: real, close: closeReal } = await tempStore();
  const gate = failNextClaim(real);
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  const loop = new JobLoop(gate.db, clock, { pollMs: 10 });
  let runs = 0;
  loop.register("work", () => {
    runs += 1;
  });
  const id = await enqueueJob(real, { queue: "work", now: clock.now() });
  gate.failNext();
  const controller = new AbortController();
  let polls = 0;
  try {
    await loop.run(controller.signal, async () => {
      polls += 1;
      if (runs > 0 || polls > 5) controller.abort();
    });
    expect(lines.join("\n")).toContain("operation=loop.tick.claimNextJob");
    expect(lines.join("\n")).toContain("database is locked");
    expect(runs).toBe(1);
    expect(polls).toBeGreaterThan(0);
    expect(await getJob(real, id)).toMatchObject({ status: "done", attempts: 1 });
    expect(loop.liveness()).toMatchObject({ polling: true, inFlight: 0, workerCount: 1 });
  } finally {
    restore();
    await closeReal();
  }
});

test("a claim failure does not cancel or repeat an in-flight handler", async () => {
  const clock = new FakeClock(1_000);
  const { db: real, close: closeReal } = await tempStore();
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
  const runningId = await enqueueJob(real, { queue: "work", now: clock.now() });
  const running = loop.tick();
  await started;
  expect(loop.liveness().inFlight).toBe(1);
  const waitingId = await enqueueJob(real, { queue: "work", now: clock.now() });
  gate.failNext();
  expect(await loop.tick()).toBeNull();
  expect(context.signal.aborted).toBe(false);
  expect(await getJob(real, runningId)).toMatchObject({ status: "running", attempts: 1 });
  expect(await getJob(real, waitingId)).toMatchObject({ status: "pending", attempts: 0 });
  expect(loop.liveness().inFlight).toBe(1);
  finish();
  await running;
  expect(runs).toBe(1);
  expect(await getJob(real, runningId)).toMatchObject({ status: "done", attempts: 1 });
  await loop.tick();
  expect(await getJob(real, waitingId)).toMatchObject({ status: "done", attempts: 1 });
  await closeReal();
});

test("production run attributes a blocked claim to loop.tick", async () => {
  const clock = new FakeClock();
  const { db, close } = await tempStore();
  const controller = new AbortController();
  let blocked = false;
  const wrapped = onClaim(db, () => {
    if (blocked) return;
    blocked = true;
    clock.advance(11_000);
  });
  sampleHostOperations();
  let operation = "idle";
  try {
    const loop = new JobLoop(wrapped, clock);
    loop.register("test", async () => {});
    await loop.run(controller.signal, async () => {
      operation = sampleHostOperations();
      controller.abort();
    });
    expect(operation).toBe("loop.tick");
  } finally {
    controller.abort();
    await close();
  }
});
