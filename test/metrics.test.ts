import { afterEach, describe, expect, test } from "bun:test";
import { metricMinutesSteps, type Db } from "../src/db";
import {
  DROPPED_SERIES_METRIC,
  MAX_SERIES,
  STATUS_BOUNDS_MS,
  createMetricsRecorder,
  flushMetrics,
} from "../src/metrics";
import { handleMetricsRequest } from "../src/settings";
import { tempStore } from "./pglite";

const MINUTE = 60_000;
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

function clock(at: number) {
  const state = { at };
  return { state, now: () => state.at };
}

function request(query: string): Request {
  return new Request(`http://127.0.0.1:8787/api/metrics?${query}`);
}

describe("metrics recorder", () => {
  test("1,000 durations in one minute flush to one row whose p95 is in the right bucket", async () => {
    const db = await store();
    const time = clock(START + 5_000);
    const recorder = createMetricsRecorder({ now: time.now });
    for (let index = 1; index <= 1_000; index++)
      recorder.recordDuration("http.request", { route: "/api/issues" }, index);
    await flushMetrics(db, { recorder, now: START + 30_000 });
    expect(
      await db.run((q) =>
        metricMinutesSteps(q, { names: ["http.request"], from: 0, to: START * 2 }),
      ),
    ).toEqual([]);
    await flushMetrics(db, { recorder, now: START + MINUTE });
    const rows = await db.run((q) =>
      metricMinutesSteps(q, { names: ["http.request"], from: 0, to: START * 2 }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ minute: START, count: 1_000, sum: 500_500, max: 1_000 });
    expect(rows[0]!.buckets!.reduce((a, b) => a + b, 0)).toBe(1_000);
    const response = await handleMetricsRequest(
      request(`names=http.request&from=${START}&to=${START + MINUTE}`),
      { store: db, role: "admin" },
    );
    const body = (await response!.json()) as {
      series: { labels: object; points: { p50: number; p95: number; p99: number }[] }[];
    };
    expect(body.series).toHaveLength(1);
    expect(body.series[0]!.labels).toEqual({ route: "/api/issues" });
    const { p50, p95, p99 } = body.series[0]!.points[0]!;
    expect(p95).toBeGreaterThan(500);
    expect(p95).toBeLessThanOrEqual(1_000);
    expect(p50).toBeGreaterThan(250);
    expect(p50).toBeLessThanOrEqual(500);
    expect(p99).toBeLessThanOrEqual(1_000);
  });

  test("the flush job deletes rows older than 14 days", async () => {
    const db = await store();
    const time = clock(START - 15 * 24 * 60 * MINUTE);
    const recorder = createMetricsRecorder({ now: time.now });
    recorder.incrementCounter("job.run", { queue: "a" });
    time.state.at = START - 13 * 24 * 60 * MINUTE;
    recorder.incrementCounter("job.run", { queue: "a" }, 3);
    await flushMetrics(db, { recorder, now: START - 13 * 24 * 60 * MINUTE + MINUTE });
    const all = { names: ["job.run"], from: 0, to: START * 2 };
    expect(await db.run((q) => metricMinutesSteps(q, all))).toHaveLength(2);
    const { deleted } = await flushMetrics(db, { recorder, now: START });
    expect(deleted).toBe(1);
    const rows = await db.run((q) => metricMinutesSteps(q, all));
    expect(rows.map((row) => [row.minute, row.count])).toEqual([
      [START - 13 * 24 * 60 * MINUTE, 3],
    ]);
  });

  test("the 5,001st series is dropped and counted", async () => {
    const db = await store();
    const recorder = createMetricsRecorder({ now: () => START });
    for (let index = 0; index < MAX_SERIES; index++)
      recorder.setGauge("queue.depth", { queue: `q${index}` }, index);
    recorder.recordDuration("http.request", { route: "extra" }, 3);
    recorder.recordDuration("http.request", { route: "extra" }, 4);
    recorder.setGauge("queue.depth", { queue: "q0" }, 7);
    expect(recorder.dropped()).toBe(2);
    await flushMetrics(db, { recorder, now: START + MINUTE });
    const window = { from: 0, to: START * 2 };
    const rows = await db.run((q) =>
      metricMinutesSteps(q, { ...window, names: ["queue.depth", "http.request"] }),
    );
    expect(rows).toHaveLength(MAX_SERIES);
    expect(rows.find((row) => row.labels.queue === "q0")).toMatchObject({ gauge: 7, max: 7 });
    const [drop] = await db.run((q) =>
      metricMinutesSteps(q, { ...window, names: [DROPPED_SERIES_METRIC] }),
    );
    expect(drop).toMatchObject({ minute: START, count: 2 });
  });

  test("a failed flush keeps its minutes and merges them with later observations", async () => {
    const db = await store();
    const time = clock(START);
    const recorder = createMetricsRecorder({ now: time.now });
    recorder.recordDuration("job.run", { queue: "a" }, 40);
    recorder.setGauge("queue.depth", {}, 3);
    const failing = {
      transaction: () => Promise.reject(new Error("database down")),
    } as unknown as Db;
    await expect(flushMetrics(failing, { recorder, now: START + MINUTE })).rejects.toThrow(
      "database down",
    );
    recorder.recordDuration("job.run", { queue: "a" }, 600);
    recorder.setGauge("queue.depth", {}, 5);
    await flushMetrics(db, { recorder, now: START + MINUTE });
    const rows = await db.run((q) =>
      metricMinutesSteps(q, { names: ["job.run", "queue.depth"], from: 0, to: START * 2 }),
    );
    expect(rows.find((row) => row.name === "job.run")).toMatchObject({
      minute: START,
      count: 2,
      sum: 640,
      max: 600,
    });
    expect(rows.find((row) => row.name === "queue.depth")).toMatchObject({ gauge: 5, max: 5 });
    expect(recorder.drain(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });

  test("a pending flush keeps its series' capacity, so a failure restores every drained minute", async () => {
    const db = await store();
    const time = clock(START);
    const recorder = createMetricsRecorder({ now: time.now });
    for (let index = 0; index < MAX_SERIES; index++)
      recorder.incrementCounter("job.run", { queue: `a${index}` });
    time.state.at = START + MINUTE;
    const drained = recorder.drain(START + MINUTE);
    for (let index = 0; index < MAX_SERIES; index++)
      recorder.incrementCounter("job.run", { queue: `b${index}` });
    expect(recorder.dropped()).toBe(MAX_SERIES);
    recorder.restore(drained);
    expect(recorder.dropped()).toBe(MAX_SERIES);
    await flushMetrics(db, { recorder, now: START + 2 * MINUTE });
    const rows = await db.run((q) =>
      metricMinutesSteps(q, { names: ["job.run", DROPPED_SERIES_METRIC], from: 0, to: START * 2 }),
    );
    const runs = rows.filter((row) => row.name === "job.run");
    expect(runs).toHaveLength(MAX_SERIES);
    expect(runs.every((row) => row.minute === START)).toBe(true);
    expect(rows.find((row) => row.name === DROPPED_SERIES_METRIC)).toMatchObject({
      minute: START + MINUTE,
      count: MAX_SERIES,
    });
    recorder.incrementCounter("job.run", { queue: "after" });
    expect(recorder.drain(Number.MAX_SAFE_INTEGER)).toHaveLength(1);
  });

  test("recording ignores values that are not numbers and never throws", () => {
    const recorder = createMetricsRecorder();
    expect(() => {
      recorder.recordDuration("x", {}, Number.NaN);
      recorder.setGauge("x", {}, Number.POSITIVE_INFINITY);
      recorder.recordDuration("x", null as never, 1);
    }).not.toThrow();
    expect(recorder.drain(Number.MAX_SAFE_INTEGER)).toEqual([]);
  });
});

describe("GET /api/metrics", () => {
  test("sums minute buckets before hourly percentiles", async () => {
    const db = await store();
    const time = clock(START);
    const recorder = createMetricsRecorder({ now: time.now });
    recorder.recordDuration("linear.call", { operation: "issue" }, 2_000);
    time.state.at = START + 10 * MINUTE;
    for (let index = 0; index < 99; index++)
      recorder.recordDuration("linear.call", { operation: "issue" }, 3);
    for (const offset of [0, 59, 61]) {
      time.state.at = START + offset * MINUTE;
      recorder.setGauge("queue.depth", {}, offset);
    }
    await flushMetrics(db, { recorder, now: START + 3 * 60 * MINUTE });
    const query = `names=linear.call,queue.depth&from=${new Date(START).toISOString()}&to=${START + 2 * 60 * MINUTE}`;
    const read = async (step: string) =>
      (await (await handleMetricsRequest(request(`${query}&step=${step}`), {
        store: db,
        role: "admin",
      }))!.json()) as { series: { name: string; points: Record<string, number | null>[] }[] };
    const minutes = (await read("minute")).series.find((series) => series.name === "linear.call")!;
    expect(minutes.points[0]!.p95).toBeGreaterThan(1_000);
    expect(minutes.points[1]!.p95).toBeLessThanOrEqual(5);
    const hours = await read("hour");
    const call = hours.series.find((series) => series.name === "linear.call")!;
    expect(call.points).toEqual([
      expect.objectContaining({ at: START, count: 100, sum: 2_297, max: 2_000 }),
    ]);
    expect(call.points[0]!.p95).toBeGreaterThan(1);
    expect(call.points[0]!.p95).toBeLessThanOrEqual(5);
    const depth = hours.series.find((series) => series.name === "queue.depth")!;
    expect(depth.points.map((point) => [point.gauge, point.max])).toEqual([
      [59, 59],
      [61, 61],
    ]);
  });

  test("counts HTTP observations at or below the 300 ms and 2,000 ms boundaries", async () => {
    const db = await store();
    const recorder = createMetricsRecorder({ now: () => START });
    for (const ms of [299, 300, 301, 1_999, 2_000, 2_001])
      recorder.recordDuration("http.request", { route: "/api/issues" }, ms);
    await flushMetrics(db, { recorder, now: START + MINUTE });
    const response = await handleMetricsRequest(
      request(`names=http.request&from=${START}&to=${START + MINUTE}`),
      { store: db, role: "admin" },
    );
    const body = (await response!.json()) as {
      series: { points: { count: number; atMostMs: Record<string, number> }[] }[];
    };
    expect(STATUS_BOUNDS_MS).toEqual([300, 2_000]);
    expect(body.series[0]!.points[0]).toMatchObject({
      count: 6,
      atMostMs: { "300": 2, "2000": 5 },
    });
  });

  test("refuses a non-admin, another origin and bad queries", async () => {
    const db = await store();
    const member = await handleMetricsRequest(request("names=http.request"), {
      store: db,
      role: "member",
    });
    expect(member!.status).toBe(403);
    const remote = await handleMetricsRequest(
      new Request("http://paws.example/api/metrics?names=http.request"),
      { store: db, role: "admin" },
    );
    expect(remote!.status).toBe(403);
    for (const query of [
      "",
      "names=a&step=day",
      "names=a&from=5&to=4",
      "names=a&from=0&to=999999999",
    ])
      expect(
        (await handleMetricsRequest(request(query), { store: db, role: "admin" }))!.status,
      ).toBe(400);
    expect(
      await handleMetricsRequest(new Request("http://127.0.0.1/api/other"), { store: db }),
    ).toBeNull();
  });
});
