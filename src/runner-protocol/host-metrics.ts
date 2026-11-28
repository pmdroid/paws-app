import { z } from "zod";

const between = (min: number, max: number) => z.number().min(min).max(max);
const ratio = between(0, 1).optional();
const bytes = between(0, 2 ** 53).optional();
const rate = between(0, 1e12).optional();

export const RunnerHostMetricsSchema = z.strictObject({
  at: between(0, Number.MAX_SAFE_INTEGER),
  cpuCount: between(1, 1024).optional(),
  cpuBusyRatio: ratio,
  diskBusyRatio: ratio,
  memoryPressureRatio: ratio,
  memoryUsedBytes: bytes,
  memoryTotalBytes: bytes,
  rootUsedBytes: bytes,
  rootSizeBytes: bytes,
  load1: between(0, 100_000).optional(),
  networkReceiveBytesPerSecond: rate,
  networkTransmitBytesPerSecond: rate,
});

export type RunnerHostMetrics = z.infer<typeof RunnerHostMetricsSchema>;

export const RUNNER_HOST_METRICS_INTERVAL_MS = 30_000;
