import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { systemClock, type Clock } from "../core";
import { HostSupervisor } from "./supervisor";
import { WakeDetector } from "./wake";

export { HostSupervisor } from "./supervisor";
export { WakeDetector, type WakeSample } from "./wake";

export function startHost(input: {
  db: Database;
  signal: AbortSignal;
  clock?: Clock;
  pollMs?: number;
  /** Stops a live agent whose run ended at the time limit. */
  stopAgent?: (itemId: string) => void;
}): { stop: () => void; supervisor: HostSupervisor } {
  const clock = input.clock ?? systemClock;
  const supervisor = new HostSupervisor(
    input.db,
    clock,
    new WakeDetector(clock),
    input.pollMs,
    input.stopAgent,
  );
  const task = supervisor.run(input.signal);
  void task.catch((caughtError1) => {
    journalCaught(caughtError1, "host.startHost", null);
    return undefined;
  });
  return {
    supervisor,
    stop() {
      supervisor.stop();
    },
  };
}
