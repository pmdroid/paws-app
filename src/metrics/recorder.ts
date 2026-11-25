import type { MetricMinuteRow } from "../db";

export type MetricLabels = Readonly<Record<string, string>>;

export const BUCKET_BOUNDS_MS = [
  1, 5, 10, 25, 50, 100, 250, 300, 500, 1_000, 2_000, 2_500, 5_000, 10_000, 30_000, 60_000, 300_000,
  1_800_000,
] as const;

export const STATUS_BOUNDS_MS = [300, 2_000] as const;

export const MAX_SERIES = 5_000;
export const DROPPED_SERIES_METRIC = "metrics.dropped_series";
const MINUTE_MS = 60_000;

type Entry = MetricMinuteRow;

export type MetricsRecorder = {
  recordDuration(name: string, labels: MetricLabels, ms: number): void;
  incrementCounter(name: string, labels: MetricLabels, by?: number): void;
  setGauge(name: string, labels: MetricLabels, value: number): void;
  drain(before: number): MetricMinuteRow[];
  restore(rows: readonly MetricMinuteRow[]): void;
  release(rows: readonly MetricMinuteRow[]): void;
  dropped(): number;
};

function labelKey(labels: MetricLabels): string {
  return JSON.stringify(Object.entries(labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function keyOf(minute: number, name: string, labels: MetricLabels): string {
  return `${minute}|${name}|${labelKey(labels)}`;
}

function bucketIndex(ms: number): number {
  const index = BUCKET_BOUNDS_MS.findIndex((bound) => ms <= bound);
  return index === -1 ? BUCKET_BOUNDS_MS.length : index;
}

function countedSeries(rows: readonly MetricMinuteRow[]): number {
  return rows.filter((row) => row.name !== DROPPED_SERIES_METRIC).length;
}

export function createMetricsRecorder(options: { now?: () => number } = {}): MetricsRecorder {
  const now = options.now ?? Date.now;
  const entries = new Map<string, Entry>();
  let dropped = 0;
  let series = 0;
  let reserved = 0;

  function blank(minute: number, name: string, labels: MetricLabels, histogram: boolean): Entry {
    return {
      minute,
      name,
      labels: { ...labels },
      count: 0,
      sum: 0,
      max: histogram ? 0 : Number.NEGATIVE_INFINITY,
      buckets: histogram ? Array.from({ length: BUCKET_BOUNDS_MS.length + 1 }, () => 0) : null,
      gauge: null,
    };
  }

  function countDrop(minute: number) {
    dropped += 1;
    const key = keyOf(minute, DROPPED_SERIES_METRIC, {});
    const found = entries.get(key) ?? blank(minute, DROPPED_SERIES_METRIC, {}, false);
    entries.set(key, found);
    found.count += 1;
    found.sum += 1;
    found.max = found.sum;
  }

  function entry(name: string, labels: MetricLabels, histogram: boolean): Entry | null {
    const minute = Math.floor(now() / MINUTE_MS) * MINUTE_MS;
    const key = keyOf(minute, name, labels);
    const found = entries.get(key);
    if (found) return found;
    if (series + reserved >= MAX_SERIES) {
      countDrop(minute);
      return null;
    }
    const created = blank(minute, name, labels, histogram);
    entries.set(key, created);
    series += 1;
    return created;
  }

  function safely(record: () => void) {
    try {
      record();
    } catch {
      dropped += 1;
    }
  }

  return {
    recordDuration(name, labels, ms) {
      safely(() => {
        if (!Number.isFinite(ms)) return;
        const found = entry(name, labels, true);
        if (!found) return;
        const value = Math.max(0, ms);
        found.count += 1;
        found.sum += value;
        found.max = Math.max(found.max, value);
        if (found.buckets) found.buckets[bucketIndex(value)]! += 1;
      });
    },
    incrementCounter(name, labels, by = 1) {
      safely(() => {
        if (!Number.isFinite(by)) return;
        const found = entry(name, labels, false);
        if (!found) return;
        found.count += by;
        found.sum += by;
        found.max = Math.max(found.max, found.sum);
      });
    },
    setGauge(name, labels, value) {
      safely(() => {
        if (!Number.isFinite(value)) return;
        const found = entry(name, labels, false);
        if (!found) return;
        found.count += 1;
        found.sum += value;
        found.max = Math.max(found.max, value);
        found.gauge = value;
      });
    },
    drain(before) {
      const rows: MetricMinuteRow[] = [];
      for (const [key, found] of entries) {
        if (found.minute >= before) continue;
        entries.delete(key);
        rows.push(found);
      }
      const counted = countedSeries(rows);
      series -= counted;
      reserved += counted;
      return rows;
    },
    release(rows) {
      reserved = Math.max(0, reserved - countedSeries(rows));
    },
    restore(rows) {
      reserved = Math.max(0, reserved - countedSeries(rows));
      safely(() => {
        for (const row of rows) {
          const key = keyOf(row.minute, row.name, row.labels);
          const found = entries.get(key);
          if (!found) {
            if (row.name === DROPPED_SERIES_METRIC) entries.set(key, row);
            else if (series + reserved >= MAX_SERIES) countDrop(row.minute);
            else {
              entries.set(key, row);
              series += 1;
            }
            continue;
          }
          found.count += row.count;
          found.sum += row.sum;
          found.max = Math.max(found.max, row.max);
          found.gauge ??= row.gauge;
          if (found.buckets && row.buckets)
            found.buckets = found.buckets.map((value, index) => value + (row.buckets![index] ?? 0));
        }
      });
    },
    dropped: () => dropped,
  };
}

export const defaultRecorder = createMetricsRecorder();

export function recordDuration(name: string, labels: MetricLabels, ms: number): void {
  defaultRecorder.recordDuration(name, labels, ms);
}

export function incrementCounter(name: string, labels: MetricLabels, by = 1): void {
  defaultRecorder.incrementCounter(name, labels, by);
}

export function setGauge(name: string, labels: MetricLabels, value: number): void {
  defaultRecorder.setGauge(name, labels, value);
}

export function statusClass(status: number | null): string {
  return status === null ? "network" : `${Math.floor(status / 100)}xx`;
}
