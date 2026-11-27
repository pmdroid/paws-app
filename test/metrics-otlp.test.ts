import { afterEach, expect, test } from "bun:test";
import { ExportResultCode } from "@opentelemetry/core";
import {
  AggregationTemporality,
  DataPointType,
  InMemoryMetricExporter,
  type MetricData,
} from "@opentelemetry/sdk-metrics";
import { metricMinutesSteps, type Db } from "../src/db";
import { BUCKET_BOUNDS_MS, createMetricsRecorder, flushMetrics } from "../src/metrics";
import {
  createTelemetry,
  parseTelemetrySettings,
  type ExporterLoaders,
  type ExporterSet,
  type TelemetrySettings,
} from "../src/telemetry";
import { tempStore } from "./pglite";

const MINUTE = 60_000;
const START = Date.UTC(2026, 10, 27, 10, 0, 0);
let closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.map((close) => close()));
  closers = [];
});

function setup(options: { fail?: boolean } = {}) {
  const memory = new InMemoryMetricExporter(AggregationTemporality.DELTA);
  const failing = (_: unknown, done: (result: { code: ExportResultCode }) => void) =>
    done({ code: ExportResultCode.FAILED });
  const exporter = options.fail
    ? Object.assign(Object.create(memory), { export: failing })
    : memory;
  const set = { metrics: () => exporter } as unknown as ExporterSet;
  const loaders = { "http/protobuf": async () => set } as unknown as ExporterLoaders;
  const failed: string[] = [];
  const telemetry = createTelemetry({
    version: "git:abc",
    instanceId: "paws.example.com",
    exporters: loaders,
    countFailure: (signal) => failed.push(signal),
  });
  return { memory, telemetry, failed };
}

function settings(metrics: Partial<TelemetrySettings["metrics"]> = {}): TelemetrySettings {
  const parsed = parseTelemetrySettings({ enabled: true, endpoint: "https://otel.example.com/" });
  return {
    ...parsed,
    alerts: { ...parsed.alerts, enabled: false },
    items: { ...parsed.items, enabled: false },
    metrics: { ...parsed.metrics, ...metrics },
  };
}

function exported(memory: InMemoryMetricExporter): MetricData[] {
  return memory
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics.flatMap((scope) => scope.metrics));
}

async function store(): Promise<Db> {
  const opened = await tempStore();
  closers.push(opened.close);
  return opened.db;
}

type Recorder = ReturnType<typeof createMetricsRecorder>;
type Handle = ReturnType<typeof setup>["telemetry"];
async function flushMinute(db: Db, telemetry: Handle, recorder: Recorder, now: number) {
  const { rows } = await flushMetrics(db, { recorder, now });
  telemetry.exportMetricMinutes(rows);
}
const drainMinute = (telemetry: Handle, recorder: Recorder, now: number) =>
  telemetry.exportMetricMinutes(recorder.drain(now));

function minuteOf(clock: { at: number }) {
  const recorder = createMetricsRecorder({ now: () => clock.at });
  recorder.incrementCounter("linear.calls", { kind: "query" }, 3);
  recorder.recordDuration("http.request", { route: "/api/issues" }, 40);
  recorder.recordDuration("http.request", { route: "/api/issues" }, 400);
  recorder.setGauge("jobs.queue_depth", { queue: "merge" }, 7);
  return recorder;
}

test("a minute with a counter, a duration and a gauge exports one sum, one histogram and one gauge", async () => {
  const db = await store();
  const { memory, telemetry } = setup();
  await telemetry.apply(settings(), null);
  await flushMinute(db, telemetry, minuteOf({ at: START + 1_000 }), START + MINUTE);
  await telemetry.flush();
  const metrics = exported(memory);
  expect(metrics.map((m) => [m.descriptor.name, m.dataPointType])).toEqual([
    ["paws.linear.calls", DataPointType.SUM],
    ["paws.http.request", DataPointType.HISTOGRAM],
    ["paws.jobs.queue_depth", DataPointType.GAUGE],
  ]);
  const [sum, histogram, gauge] = metrics;
  expect(sum!.aggregationTemporality).toBe(AggregationTemporality.DELTA);
  expect(sum!.dataPoints[0]).toMatchObject({ attributes: { kind: "query" }, value: 3 });
  const counts = Array.from({ length: BUCKET_BOUNDS_MS.length + 1 }, () => 0);
  counts[BUCKET_BOUNDS_MS.indexOf(50)] = 1;
  counts[BUCKET_BOUNDS_MS.indexOf(500)] = 1;
  expect(histogram!.dataPoints[0]).toMatchObject({
    attributes: { route: "/api/issues" },
    value: { count: 2, sum: 440, max: 400, buckets: { boundaries: [...BUCKET_BOUNDS_MS], counts } },
  });
  expect(gauge!.dataPoints[0]).toMatchObject({ attributes: { queue: "merge" }, value: 7 });
  await telemetry.shutdown();
});

test("a failing exporter leaves the database rows written", async () => {
  const db = await store();
  const { telemetry, failed } = setup({ fail: true });
  await telemetry.apply(settings(), null);
  await flushMinute(db, telemetry, minuteOf({ at: START + 1_000 }), START + MINUTE);
  await telemetry.flush();
  expect(failed).toContain("metrics");
  const names = ["linear.calls", "http.request", "jobs.queue_depth"];
  const rows = await db.run((q) => metricMinutesSteps(q, { names, from: 0, to: START * 2 }));
  expect(rows).toHaveLength(3);
  await telemetry.shutdown();
});

test("nothing is sent while export or the metrics signal is off", async () => {
  for (const off of [{ ...settings(), enabled: false }, settings({ enabled: false })]) {
    const { memory, telemetry } = setup();
    await telemetry.apply(off, null);
    drainMinute(telemetry, minuteOf({ at: START + 1_000 }), START + MINUTE);
    await telemetry.flush();
    expect(memory.getMetrics()).toEqual([]);
  }
});

test("minutes merge below the interval, cumulative keeps running totals and averages replace histograms", async () => {
  const { memory, telemetry } = setup();
  await telemetry.apply(
    settings({ intervalMinutes: 5, temporality: "cumulative", durations: "average" }),
    null,
  );
  const clock = { at: START + 1_000 };
  const recorder = minuteOf(clock);
  drainMinute(telemetry, recorder, START + MINUTE);
  clock.at = START + MINUTE + 1_000;
  recorder.incrementCounter("linear.calls", { kind: "query" }, 2);
  recorder.recordDuration("http.request", { route: "/api/issues" }, 100);
  recorder.setGauge("jobs.queue_depth", { queue: "merge" }, 4);
  drainMinute(telemetry, recorder, START + 2 * MINUTE);
  const bad = { minute: START, name: "broken", labels: {}, count: Number.NaN, sum: 1, max: 1 };
  telemetry.exportMetricMinutes([{ ...bad, buckets: null, gauge: null }]);
  await telemetry.flush();
  const byName = (metrics: MetricData[]) =>
    Object.fromEntries(metrics.map((m) => [m.descriptor.name, m]));
  const first = byName(exported(memory));
  expect(first["paws.broken"]).toBeUndefined();
  expect(first["paws.http.request"]).toBeUndefined();
  expect(first["paws.linear.calls"]!.aggregationTemporality).toBe(
    AggregationTemporality.CUMULATIVE,
  );
  expect(first["paws.linear.calls"]!.dataPoints[0]!.value).toBe(5);
  expect(first["paws.jobs.queue_depth"]!.dataPoints[0]!.value).toBe(4);
  expect(first["paws.http.request.avg_ms"]!.dataPoints[0]).toMatchObject({
    attributes: { route: "/api/issues" },
    value: 180,
  });
  memory.reset();
  clock.at = START + 2 * MINUTE + 1_000;
  recorder.incrementCounter("linear.calls", { kind: "query" }, 1);
  drainMinute(telemetry, recorder, START + 3 * MINUTE);
  await telemetry.flush();
  const second = byName(exported(memory));
  expect(second["paws.linear.calls"]!.dataPoints[0]!.value).toBe(6);
  expect(second["paws.jobs.queue_depth"]).toBeUndefined();
  await telemetry.shutdown();
});
