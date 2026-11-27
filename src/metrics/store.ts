import {
  deleteMetricMinutesBeforeSteps,
  insertMetricMinutesSteps,
  metricMinutesSteps,
  type Db,
  type MetricMinuteRow,
} from "../db";
import {
  BUCKET_BOUNDS_MS,
  STATUS_BOUNDS_MS,
  defaultRecorder,
  type MetricsRecorder,
} from "./recorder";

export const METRICS_FLUSH_JOB = "metrics.flush";
export const METRICS_FLUSH_EVERY_MS = 60_000;
export const METRICS_RETENTION_MS = 14 * 24 * 60 * 60_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export type MetricStep = "minute" | "hour";

export type MetricPoint = {
  at: number;
  count: number;
  sum: number;
  max: number;
  gauge: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  atMostMs: Record<string, number> | null;
};

export type MetricSeries = { name: string; labels: Record<string, string>; points: MetricPoint[] };

export async function flushMetrics(
  db: Db,
  options: { recorder?: MetricsRecorder; now?: number } = {},
): Promise<{ written: number; deleted: number; rows: readonly MetricMinuteRow[] }> {
  const now = options.now ?? Date.now();
  const recorder = options.recorder ?? defaultRecorder;
  const rows = recorder.drain(Math.floor(now / MINUTE_MS) * MINUTE_MS);
  try {
    const result = await db.transaction(function* (q) {
      yield* insertMetricMinutesSteps(q, rows);
      const deleted = yield* deleteMetricMinutesBeforeSteps(q, now - METRICS_RETENTION_MS);
      return { written: rows.length, deleted, rows };
    });
    recorder.release(rows);
    return result;
  } catch (error) {
    recorder.restore(rows);
    throw error;
  }
}

function bucketQuantile(
  buckets: readonly number[],
  count: number,
  max: number,
  quantile: number,
): number | null {
  if (count <= 0) return null;
  const rank = quantile * count;
  let seen = 0;
  for (const [index, inBucket] of buckets.entries()) {
    if (inBucket <= 0 || seen + inBucket < rank) {
      seen += inBucket;
      continue;
    }
    const lower = index === 0 ? 0 : BUCKET_BOUNDS_MS[index - 1]!;
    const upper = BUCKET_BOUNDS_MS[index] ?? max;
    const estimate = lower + ((upper - lower) * (rank - seen)) / inBucket;
    return Math.min(estimate, max);
  }
  return max;
}

function countAtMost(buckets: readonly number[], boundMs: number): number {
  const last = BUCKET_BOUNDS_MS.indexOf(boundMs as (typeof BUCKET_BOUNDS_MS)[number]);
  return buckets.slice(0, last + 1).reduce((total, inBucket) => total + inBucket, 0);
}

function merge(into: MetricMinuteRow, row: MetricMinuteRow) {
  into.count += row.count;
  into.sum += row.sum;
  into.max = Math.max(into.max, row.max);
  if (row.gauge !== null) into.gauge = row.gauge;
  if (row.buckets)
    into.buckets = row.buckets.map((value, index) => value + (into.buckets?.[index] ?? 0));
}

function point(row: MetricMinuteRow): MetricPoint {
  const quantile = (q: number) =>
    row.buckets ? bucketQuantile(row.buckets, row.count, row.max, q) : null;
  return {
    at: row.minute,
    count: row.count,
    sum: row.sum,
    max: row.max,
    gauge: row.gauge,
    p50: quantile(0.5),
    p95: quantile(0.95),
    p99: quantile(0.99),
    atMostMs: row.buckets
      ? Object.fromEntries(
          STATUS_BOUNDS_MS.map((bound) => [bound, countAtMost(row.buckets!, bound)]),
        )
      : null,
  };
}

export async function readMetricSeries(
  db: Db,
  query: { names: readonly string[]; from: number; to: number; step: MetricStep },
): Promise<MetricSeries[]> {
  const rows = await db.run((q) => metricMinutesSteps(q, query));
  const size = query.step === "hour" ? HOUR_MS : MINUTE_MS;
  const series = new Map<string, { name: string; labels: Record<string, string> }>();
  const points = new Map<string, Map<number, MetricMinuteRow>>();
  for (const row of rows) {
    const key = JSON.stringify([row.name, Object.entries(row.labels).sort()]);
    if (!series.has(key)) series.set(key, { name: row.name, labels: row.labels });
    const byTime = points.get(key) ?? new Map<number, MetricMinuteRow>();
    points.set(key, byTime);
    const at = Math.floor(row.minute / size) * size;
    const found = byTime.get(at);
    if (found) merge(found, row);
    else byTime.set(at, { ...row, minute: at, buckets: row.buckets && [...row.buckets] });
  }
  return [...series].map(([key, { name, labels }]) => ({
    name,
    labels,
    points: [...points.get(key)!.values()].map(point),
  }));
}
