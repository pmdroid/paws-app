import { systemClock, type Clock } from "../core";
import { journal, journalCaught } from "../journal";

import {
  activeHostOperations,
  sampleHostOperations,
  sampleSlowestHostOperation,
} from "../host-operation";
import type { HostMetrics } from "./process-metrics";

export function createLagWatchdog(input: {
  clock?: Clock;
  log?: (line: string) => void;
  recover: (lagMs: number, startedAt: number) => Promise<void>;
  metrics?: Pick<HostMetrics, "recordDuration">;
}) {
  const clock = input.clock ?? systemClock;
  let previous = clock.mono();
  let wall = clock.now();
  let active = activeHostOperations();
  let minute = Number.NaN;
  let minuteLongest = 0;
  return () => {
    const mono = clock.mono();
    const lag = Math.max(0, mono - previous - 1000);
    // Use the last responsive sample: authority expiring before the next tick was still live.
    const startedAt = wall;
    previous = mono;
    wall = clock.now();
    const names = sampleHostOperations();
    const before = active;
    active = activeHostOperations();
    const slowest = sampleSlowestHostOperation();
    const at = Math.floor(wall / 60_000);
    if (at !== minute) {
      minute = at;
      minuteLongest = 0;
    }
    if (input.metrics && slowest && slowest.ms > minuteLongest) {
      minuteLongest = slowest.ms;
      input.metrics.recordDuration("host.operation", { operation: slowest.name }, slowest.ms);
    }
    if (lag > 5000) {
      (input.log ?? journal)(`event loop stalled ${lag} ms operation=${names} before=${before}`);
      input.recover(lag, startedAt).catch((error: unknown) => {
        journalCaught(error, "lag.recover", null);
      });
    }
  };
}
