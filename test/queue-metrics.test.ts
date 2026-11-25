import { afterEach, describe, expect, test } from "bun:test";
import { FakeClock } from "../src/core";
import { JobLoop, OutboxDispatcher, enqueueJob, enqueueOutbox, type Db } from "../src/db";
import { createMetricsRecorder, recordQueueDepths, type MetricsRecorder } from "../src/metrics";
import { tempStore } from "./pglite";

const START = Date.UTC(2026, 10, 25, 10, 0, 0);
let closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

async function store(): Promise<Db> {
  const opened = await tempStore();
  closers.push(opened.close);
  return opened.db;
}

function observed(clock: FakeClock): MetricsRecorder {
  return createMetricsRecorder({ now: () => clock.now() });
}

function labelsOf(recorder: MetricsRecorder, name: string) {
  return recorder
    .drain(Number.POSITIVE_INFINITY)
    .filter((row) => row.name === name)
    .map((row) => row.labels);
}

describe("queue metrics", () => {
  test("a job enqueued at t=0 and claimed at t=3 s records a 3 s job.wait for its queue", async () => {
    const db = await store();
    const clock = new FakeClock(START);
    const recorder = observed(clock);
    const loop = new JobLoop(db, clock, { observe: recorder.recordDuration.bind(recorder) });
    loop.register("report", () => clock.advance(250));
    await enqueueJob(db, { queue: "report", now: START, runAt: START });
    clock.advance(3_000);
    await loop.tick();
    const rows = recorder.drain(Number.POSITIVE_INFINITY);
    const wait = rows.find((row) => row.name === "job.wait");
    expect(wait?.labels).toEqual({ queue: "report" });
    expect(wait?.sum).toBe(3_000);
    const run = rows.find((row) => row.name === "job.run");
    expect(run?.labels).toEqual({ queue: "report", outcome: "done" });
    expect(run?.sum).toBe(250);
  });

  test("a throwing handler records a failed job.run", async () => {
    const db = await store();
    const clock = new FakeClock(START);
    const recorder = observed(clock);
    const loop = new JobLoop(db, clock, { observe: recorder.recordDuration.bind(recorder) });
    loop.register("report", () => {
      throw new Error("boom");
    });
    await enqueueJob(db, { queue: "report", now: START, runAt: START });
    await loop.tick();
    expect(labelsOf(recorder, "job.run")).toEqual([{ queue: "report", outcome: "failed" }]);
  });

  test("outbox delivery records its wait and delivery time by kind and outcome", async () => {
    const db = await store();
    const clock = new FakeClock(START);
    const recorder = observed(clock);
    const outbox = new OutboxDispatcher(db, clock, {
      observe: recorder.recordDuration.bind(recorder),
    });
    outbox.setHandler(() => clock.advance(40));
    await enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      idempotencyKey: "one",
      delivery: "critical",
      now: START,
    });
    clock.advance(1_500);
    await outbox.tick();
    await outbox.idle();
    const rows = recorder.drain(Number.POSITIVE_INFINITY);
    const wait = rows.find((row) => row.name === "outbox.wait");
    expect(wait?.labels).toEqual({ kind: "critical" });
    expect(wait?.sum).toBe(1_500);
    const deliver = rows.find((row) => row.name === "outbox.deliver");
    expect(deliver?.labels).toEqual({ kind: "critical", outcome: "delivered" });
    expect(deliver?.sum).toBe(40);
  });

  test("the gauge query reports depth and oldest age per queue and kind", async () => {
    const db = await store();
    await enqueueJob(db, { queue: "report", now: START, runAt: START - 10_000 });
    await enqueueJob(db, { queue: "report", now: START, runAt: START - 4_000 });
    await enqueueJob(db, { queue: "sweep", now: START, runAt: START - 1_000 });
    await enqueueJob(db, { queue: "later", now: START, runAt: START + 60_000 });
    await enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      idempotencyKey: "a",
      delivery: "progress",
      now: START - 7_000,
    });
    const recorder = createMetricsRecorder({ now: () => START });
    await recordQueueDepths(db, { recorder, now: START });
    const rows = recorder.drain(Number.POSITIVE_INFINITY);
    const gauges = (name: string) =>
      Object.fromEntries(
        rows
          .filter((row) => row.name === name)
          .map((row) => [Object.values(row.labels)[0], row.gauge]),
      );
    expect(gauges("job.depth")).toEqual({ report: 2, sweep: 1 });
    expect(gauges("job.oldest_age_ms")).toEqual({ report: 10_000, sweep: 1_000 });
    expect(gauges("outbox.depth")).toEqual({ progress: 1 });
    expect(gauges("outbox.oldest_age_ms")).toEqual({ progress: 7_000 });
  });
});
