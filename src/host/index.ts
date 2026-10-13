import type { Database } from "bun:sqlite";
import { systemClock, type Clock } from "../core";
import type { WorkItemRecord } from "../db";
import { HostSupervisor, type AgentAlive } from "./supervisor";
import { WakeDetector } from "./wake";

export { HostSupervisor, type AgentAlive } from "./supervisor";
export { WakeDetector, type WakeSample } from "./wake";

export function startHost(input: {
  db: Database;
  signal: AbortSignal;
  clock?: Clock;
  agentAlive?: AgentAlive;
  pollMs?: number;
  /** After a sleep longer than two hours, check out fresh main and keep the WIP branch. */
  restartFromMain?: (item: WorkItemRecord) => void;
  restartFromMainBlocked?: (item: WorkItemRecord) => string | null;
}): { stop: () => void; supervisor: HostSupervisor } {
  const clock = input.clock ?? systemClock;
  const supervisor = new HostSupervisor(
    input.db,
    clock,
    new WakeDetector(clock),
    input.agentAlive,
    input.pollMs,
    input.restartFromMain,
    input.restartFromMainBlocked,
  );
  const task = supervisor.run(input.signal);
  void task.catch(() => undefined);
  return {
    supervisor,
    stop() {
      supervisor.stop();
    },
  };
}
