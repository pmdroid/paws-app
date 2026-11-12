import { systemClock, type Clock } from "../core";
import { journal, journalCaught } from "../journal";

import { activeHostOperations, sampleHostOperations } from "../host-operation";

export function createLagWatchdog(input: {
  clock?: Clock;
  log?: (line: string) => void;
  recover: (lagMs: number, startedAt: number) => Promise<void>;
}) {
  const clock = input.clock ?? systemClock;
  let previous = clock.mono();
  let wall = clock.now();
  let active = activeHostOperations();
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
    if (lag > 5000) {
      (input.log ?? journal)(`event loop stalled ${lag} ms operation=${names} before=${before}`);
      input.recover(lag, startedAt).catch((error: unknown) => {
        journalCaught(error, "lag.recover", null);
      });
    }
  };
}
