import { describe, expect, test } from "bun:test";
import { FakeClock } from "../core";
import { enqueueJob, JobLoop, listJobs, migrate, openDatabase } from "./index";

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
