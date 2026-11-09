import { systemClock, type Clock } from "../core";
import { journal } from "../journal";

import { sampleHostOperations } from "../core";

export function createLagWatchdog(input: {
  clock?: Clock;
  log?: (line: string) => void;
  recover: (lagMs: number, startedAt: number) => void;
}) {
  const clock = input.clock ?? systemClock;
  let previous = clock.mono();
  let wall = clock.now();
  return () => {
    const mono = clock.mono();
    const lag = Math.max(0, mono - previous - 1000);
    // Use the last responsive sample: authority expiring before the next tick was still live.
    const startedAt = wall;
    previous = mono;
    wall = clock.now();
    const names = sampleHostOperations();
    if (lag > 5000) {
      (input.log ?? journal)(`event loop stalled ${lag} ms operation=${names}`);
      input.recover(lag, startedAt);
    }
  };
}
