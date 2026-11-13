import { journalCaught } from "../journal";
import type { Db } from "../db";
import { sleep, systemClock, type Clock } from "../core";
import { HostSupervisor, restartDelayMs } from "./supervisor";
import { WakeDetector } from "./wake";

export { HostSupervisor } from "./supervisor";
export { WakeDetector, type WakeSample } from "./wake";

export function startHost(input: {
  store: Db;
  signal: AbortSignal;
  clock?: Clock;
  pollMs?: number;
  /** Stops a live agent whose run ended at the time limit. */
  stopAgent?: (itemId: string) => void;
  sleeper?: (ms: number, signal?: AbortSignal) => Promise<void>;
}): { stop: () => void; supervisor: HostSupervisor } {
  const clock = input.clock ?? systemClock;
  const supervisor = new HostSupervisor(
    input.store,
    clock,
    new WakeDetector(clock),
    input.pollMs,
    input.stopAgent,
  );
  const sleeper = input.sleeper ?? sleep;
  void (async () => {
    let failures = 0;
    while (!input.signal.aborted) {
      try {
        await supervisor.run(input.signal, sleeper);
        return;
      } catch (caughtError1) {
        failures += 1;
        journalCaught(caughtError1, "host.startHost", null);
        await sleeper(restartDelayMs(failures), input.signal);
      }
    }
  })();
  return {
    supervisor,
    stop() {
      supervisor.stop();
    },
  };
}

export { createLagWatchdog } from "./lag";
