import { expect, test } from "bun:test";
import { FakeClock } from "../core";
import { trackHostOperation } from "../host-operation";
import { createLagWatchdog } from "./lag";
import { createProcessMetrics, type HostMetrics, type ProcessSample } from "./process-metrics";

function recording(clock: FakeClock) {
  const calls: { minute: number; name: string; labels: object; value: number }[] = [];
  const add = (name: string, labels: object, value: number) =>
    calls.push({ minute: Math.floor(clock.now() / 60_000), name, labels, value });
  const metrics: HostMetrics = { recordDuration: add, setGauge: add };
  const values = (name: string) => calls.filter((c) => c.name === name).map((c) => c.value);
  return { calls, metrics, values };
}

test("a 300 ms lag is recorded and CPU and RSS gauges are set every second", () => {
  const clock = new FakeClock();
  const { metrics, values } = recording(clock);
  const samples: ProcessSample[] = [
    { lagMs: 0, cpuMicros: 0, rssBytes: 0, heapUsedBytes: 0 },
    { lagMs: 300, cpuMicros: 500_000, rssBytes: 100, heapUsedBytes: 40 },
    { lagMs: 5, cpuMicros: 750_000, rssBytes: 120, heapUsedBytes: 50 },
  ];
  const tick = createProcessMetrics({ metrics, clock, sample: () => samples.shift()! });
  clock.advance(1000);
  tick();
  clock.advance(1000);
  tick();
  expect(values("process.event_loop_lag")).toEqual([300, 5]);
  expect(values("process.cpu_percent")).toEqual([50, 25]);
  expect(values("process.rss_bytes")).toEqual([100, 120]);
  expect(values("process.heap_used_bytes")).toEqual([40, 50]);
});

test("a host operation that runs 2 s shows up under its name for that minute", () => {
  const clock = new FakeClock();
  const { calls, metrics } = recording(clock);
  const sample = createLagWatchdog({ clock, metrics, log: () => {}, recover: async () => {} });
  trackHostOperation(
    "job:linear.delivery",
    () => clock.advance(2_000),
    () => clock.mono(),
  );
  sample();
  trackHostOperation(
    "job:quick",
    () => clock.advance(100),
    () => clock.mono(),
  );
  sample();
  expect(calls).toEqual([
    {
      minute: Math.floor(clock.now() / 60_000),
      name: "host.operation",
      labels: { operation: "job:linear.delivery" },
      value: 2_000,
    },
  ]);
});
