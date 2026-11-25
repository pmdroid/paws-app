import { monitorEventLoopDelay } from "node:perf_hooks";
import { systemClock, type Clock } from "../core";

export type HostMetrics = {
  recordDuration(name: string, labels: Readonly<Record<string, string>>, ms: number): void;
  setGauge(name: string, labels: Readonly<Record<string, string>>, value: number): void;
};

export type ProcessSample = {
  lagMs: number;
  cpuMicros: number;
  rssBytes: number;
  heapUsedBytes: number;
};

export function processSampler(signal?: AbortSignal): () => ProcessSample {
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  signal?.addEventListener("abort", () => delay.disable(), { once: true });
  return () => {
    const lagMs = delay.count > 0 ? delay.max / 1e6 : 0;
    delay.reset();
    const cpu = process.cpuUsage();
    const memory = process.memoryUsage();
    return {
      lagMs,
      cpuMicros: cpu.user + cpu.system,
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    };
  };
}

export function createProcessMetrics(input: {
  metrics: HostMetrics;
  sample?: () => ProcessSample;
  clock?: Clock;
  signal?: AbortSignal;
}): () => void {
  const clock = input.clock ?? systemClock;
  const sample = input.sample ?? processSampler(input.signal);
  let previous = { mono: clock.mono(), cpuMicros: sample().cpuMicros };
  return () => {
    const mono = clock.mono();
    const next = sample();
    const elapsedMs = mono - previous.mono;
    const { metrics } = input;
    metrics.recordDuration("process.event_loop_lag", {}, next.lagMs);
    if (elapsedMs > 0)
      metrics.setGauge(
        "process.cpu_percent",
        {},
        ((next.cpuMicros - previous.cpuMicros) / 1000 / elapsedMs) * 100,
      );
    metrics.setGauge("process.rss_bytes", {}, next.rssBytes);
    metrics.setGauge("process.heap_used_bytes", {}, next.heapUsedBytes);
    previous = { mono, cpuMicros: next.cpuMicros };
  };
}
