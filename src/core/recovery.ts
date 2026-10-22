import { LONG_SLEEP_MS } from "./limits";
import type { WorkItemState } from "./states";
import type { Checkpoint } from "./types";

export const IN_FLIGHT_ITEM_STATES = [
  "running",
  "verifying",
  "recovering",
  "awaiting_input",
  "paused",
  "merge_queue",
] as const satisfies readonly WorkItemState[];

/** Awake time counts while a resume or a merge is actually in progress. */
export const AWAKE_ITEM_STATES = [
  "running",
  "verifying",
  "merge_queue",
  "recovering",
] as const satisfies readonly WorkItemState[];

const RESUMABLE: ReadonlySet<WorkItemState> = new Set([
  "running",
  "verifying",
  "recovering",
  "merge_queue",
]);

export function isInFlightItemState(state: WorkItemState): boolean {
  return (IN_FLIGHT_ITEM_STATES as readonly string[]).includes(state);
}

export function isAwakeItemState(state: WorkItemState): boolean {
  return (AWAKE_ITEM_STATES as readonly string[]).includes(state);
}

export type StartupDecision =
  | { type: "none" }
  | { type: "resume"; freshSession: true; checkpoint: Checkpoint | null; reattach?: true }
  | { type: "ask_restart" }
  | { type: "reverify" };

export type WakeDecision =
  | { type: "ignore" }
  | { type: "continue" }
  | { type: "reverify" }
  | { type: "restart_session"; checkpoint: Checkpoint }
  | { type: "restart_from_main" }
  | { type: "fail"; reason: "no_checkpoint" };

function mergeWasInProgress(state: WorkItemState, checkpoint: Checkpoint | null): boolean {
  return state === "merge_queue" || checkpoint?.phase === "merge_queue";
}

/**
 * Process start. A running or verifying item is resumed once in a fresh session,
 * from its checkpoint or, without one, from its branch. The next start, still
 * unfinished, asks in Linear whether to start it again. A merge never continues.
 */
export function decideStartup(input: {
  itemState: WorkItemState;
  recoveryAttempts: number;
  checkpoint: Checkpoint | null;
  runnerHoldsWork?: boolean;
}): StartupDecision {
  if (!RESUMABLE.has(input.itemState)) return { type: "none" };
  if (mergeWasInProgress(input.itemState, input.checkpoint)) return { type: "reverify" };
  if (input.runnerHoldsWork)
    return { type: "resume", freshSession: true, checkpoint: input.checkpoint, reattach: true };
  if (input.recoveryAttempts >= 1) return { type: "ask_restart" };
  return { type: "resume", freshSession: true, checkpoint: input.checkpoint };
}

/**
 * Lid-open policy. More than two hours asleep restarts from fresh main.
 * Any sleep during merge fails closed into a re-verify. A live agent keeps going.
 * A dead agent restarts from the last checkpoint with a fresh session.
 */
export function decideWake(input: {
  sleptMs: number;
  itemState: WorkItemState;
  agentAlive: boolean;
  checkpoint: Checkpoint | null;
}): WakeDecision {
  if (!isInFlightItemState(input.itemState)) return { type: "ignore" };
  if (input.sleptMs > LONG_SLEEP_MS) return { type: "restart_from_main" };
  if (mergeWasInProgress(input.itemState, input.checkpoint)) return { type: "reverify" };
  if (input.itemState === "awaiting_input" || input.itemState === "paused")
    return { type: "continue" };
  if (
    input.agentAlive &&
    (input.itemState === "running" ||
      input.itemState === "verifying" ||
      input.itemState === "recovering")
  ) {
    return { type: "continue" };
  }
  if (input.checkpoint) return { type: "restart_session", checkpoint: input.checkpoint };
  return { type: "fail", reason: "no_checkpoint" };
}

export function formatPauseNote(sleptMs: number, outcome: "resuming" | "fresh_main"): string {
  const minutes = Math.max(1, Math.round(sleptMs / 60_000));
  if (outcome === "fresh_main") {
    return `Paused for ${minutes} min (laptop asleep). Restarting from fresh main.`;
  }
  return `Paused for ${minutes} min (laptop asleep), resuming.`;
}

export function pauseOutcome(decision: WakeDecision): "resuming" | "fresh_main" | null {
  switch (decision.type) {
    case "restart_from_main":
      return "fresh_main";
    case "ignore":
    case "fail":
      return null;
    default:
      return "resuming";
  }
}
