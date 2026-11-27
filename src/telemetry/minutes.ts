import { ValueType, type Attributes, type HrTime } from "@opentelemetry/api";
import type { Resource } from "@opentelemetry/resources";
import {
  AggregationTemporality,
  DataPointType,
  type CollectionResult,
  type MetricData,
  type MetricProducer,
} from "@opentelemetry/sdk-metrics";
import type { MetricMinuteRow } from "../db";
import { BUCKET_BOUNDS_MS } from "../metrics";
import type { TelemetrySettings } from "./settings";

const MINUTE_MS = 60_000;
type Kind = "sum" | "histogram" | "gauge";

type Series = {
  kind: Kind;
  name: string;
  labels: Record<string, string>;
  start: number;
  end: number;
  count: number;
  sum: number;
  max: number;
  buckets: number[];
  gauge: number;
};

export type MinuteTotals = Map<string, Series>;

function kindOf(row: MetricMinuteRow): Kind | null {
  const values = [row.minute, row.count, row.sum, row.max, ...(row.buckets ?? []), row.gauge ?? 0];
  if (!values.every(Number.isFinite) || !row.name || typeof row.labels !== "object") return null;
  if (row.buckets) return row.buckets.length === BUCKET_BOUNDS_MS.length + 1 ? "histogram" : null;
  return row.gauge === null ? "sum" : "gauge";
}

function add(into: Map<string, Series>, row: MetricMinuteRow, kind: Kind) {
  const labels = Object.fromEntries(
    Object.entries(row.labels).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  const key = JSON.stringify([kind, row.name, labels]);
  const found = into.get(key);
  if (!found) {
    const { name, minute: start, count, sum, max } = row;
    const buckets = [...(row.buckets ?? [])];
    const end = start + MINUTE_MS;
    into.set(key, {
      kind,
      name,
      labels,
      start,
      end,
      count,
      sum,
      max,
      buckets,
      gauge: row.gauge ?? 0,
    });
    return;
  }
  if (row.gauge !== null && row.minute + MINUTE_MS >= found.end) found.gauge = row.gauge;
  found.start = Math.min(found.start, row.minute);
  found.end = Math.max(found.end, row.minute + MINUTE_MS);
  found.count += row.count;
  found.sum += row.sum;
  found.max = Math.max(found.max, row.max);
  found.buckets = found.buckets.map((value, index) => value + (row.buckets?.[index] ?? 0));
}

const hr = (ms: number): HrTime => [Math.floor(ms / 1000), (ms % 1000) * 1_000_000];

function metricOf(series: Series, settings: TelemetrySettings["metrics"], cumulative: boolean) {
  const average = series.kind === "histogram" && settings.durations === "average";
  if (average && series.count <= 0) return null;
  const point = {
    startTime: hr(series.start),
    endTime: hr(series.end),
    attributes: series.labels as Attributes,
  };
  const name = `paws.${series.name}${average ? ".avg_ms" : ""}`;
  const unit = series.kind === "histogram" ? "ms" : "";
  const base = {
    descriptor: { name, description: "", unit, valueType: ValueType.DOUBLE },
    aggregationTemporality: cumulative
      ? AggregationTemporality.CUMULATIVE
      : AggregationTemporality.DELTA,
  };
  if (series.kind === "sum")
    return {
      ...base,
      dataPointType: DataPointType.SUM,
      isMonotonic: series.sum >= 0,
      dataPoints: [{ ...point, value: series.sum }],
    } satisfies MetricData;
  if (series.kind === "gauge" || average)
    return {
      ...base,
      dataPointType: DataPointType.GAUGE,
      dataPoints: [{ ...point, value: average ? series.sum / series.count : series.gauge }],
    } satisfies MetricData;
  const { count, sum, max } = series;
  const buckets = { boundaries: [...BUCKET_BOUNDS_MS], counts: [...series.buckets] };
  return {
    ...base,
    dataPointType: DataPointType.HISTOGRAM,
    dataPoints: [{ ...point, value: { buckets, count, sum, max } }],
  } satisfies MetricData;
}

export function createMinuteProducer(
  settings: TelemetrySettings["metrics"],
  resource: Resource,
  scope: { name: string; version: string },
  totals: MinuteTotals,
) {
  let pending: MinuteTotals = new Map();
  const cumulative = settings.temporality === "cumulative";
  const producer: MetricProducer = {
    async collect(): Promise<CollectionResult> {
      const drained = cumulative ? [...totals.values(), ...pending.values()] : pending.values();
      pending = new Map();
      const metrics: MetricData[] = [];
      const errors: unknown[] = [];
      for (const series of drained)
        try {
          const metric = metricOf(series, settings, cumulative);
          if (metric) metrics.push(metric);
        } catch (error) {
          errors.push(error);
        }
      return {
        resourceMetrics: {
          resource,
          scopeMetrics: metrics.length === 0 ? [] : [{ scope, metrics }],
        },
        errors,
      };
    },
  };
  return {
    producer,
    add(rows: readonly MetricMinuteRow[]) {
      for (const row of rows)
        try {
          const kind = kindOf(row);
          if (!kind) continue;
          const running =
            kind === "sum" || (kind === "histogram" && settings.durations === "histogram");
          add(cumulative && running ? totals : pending, row, kind);
        } catch {
          continue;
        }
    },
  };
}
