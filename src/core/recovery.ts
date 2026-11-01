import { RESUME_AGAIN_AFTER_MS } from "./limits";
import { IN_FLIGHT_ITEM_STATES, type WorkItemState } from "./states";
import type { Checkpoint } from "./types";

/** Awake time counts while a resume or a merge is actually in progress. */
export const AWAKE_ITEM_STATES = [
  "running",
  "verifying",
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

/**
 * Where an in-flight item's time goes. Only `agent` and `closeout` count toward the
 * awake-time cap. `recheck` is Paws checking a candidate Closeout already accepted
 * again: in the merge queue (PAS-470), or after a restart re-verifies it.
 */
export type AwakeCategory = "agent" | "closeout" | "waiting" | "recheck";

export function awakeCategory(
  state: WorkItemState,
  checkpoint: Checkpoint | null,
  acceptedHead: string | null = null,
): AwakeCategory | null {
  if (state === "awaiting_input" || state === "paused") return "waiting";
  if (!isAwakeItemState(state)) return null;
  if (state === "running") return "agent";
  if (checkpoint?.phase === "merge_queue") return "recheck";
  if (acceptedHead !== null && checkpoint?.wipCommit === acceptedHead) return "recheck";
  return state === "verifying" ? "closeout" : "agent";
}

export function countsAwakeTime(
  state: WorkItemState,
  checkpoint: Checkpoint | null,
  acceptedHead: string | null = null,
): boolean {
  const category = awakeCategory(state, checkpoint, acceptedHead);
  return category === "agent" || category === "closeout";
}

export type StartupDecision =
  | { type: "none" }
  | { type: "resume"; freshSession: true; checkpoint: Checkpoint | null; reattach?: true }
  | { type: "ask_restart" }
  | { type: "reverify"; resumed?: true }
  | { type: "keep_place"; mergeCallInFlight: boolean };

export function hasVerificationCandidate(checkpoint: Checkpoint | null): boolean {
  return (
    checkpoint?.phase === "verifying" &&
    typeof checkpoint.wipCommit === "string" &&
    checkpoint.wipCommit !== ""
  );
}

function mergeWasInProgress(state: WorkItemState, checkpoint: Checkpoint | null): boolean {
  return state === "merge_queue" || checkpoint?.phase === "merge_queue";
}

/**
 * Process start. A running or verifying item is resumed once in a fresh session,
 * from its checkpoint or, without one, from its branch. The next start, still
 * unfinished, asks in Linear whether to start it again. An item waiting in the merge
 * queue keeps its place; its merge job first asks GitHub whether a merge call that may
 * have been in flight went through. One whose run was still active re-verifies, as
 * does a re-verify cut short by the restart. A verifying item whose runner still
 * holds its Closeout review or check run re-verifies and attaches to that work.
 */
export function decideStartup(input: {
  itemState: WorkItemState;
  recoveryAttempts: number;
  checkpoint: Checkpoint | null;
  runnerHoldsWork?: boolean;
  sinceResumeMs?: number;
  mergeCallInFlight?: boolean;
  runActive?: boolean;
}): StartupDecision {
  if (!RESUMABLE.has(input.itemState)) return { type: "none" };
  // A run still active in the lane was cut short mid-work, so that item re-verifies.
  if (input.itemState === "merge_queue" && input.runActive !== true)
    return { type: "keep_place", mergeCallInFlight: input.mergeCallInFlight === true };
  if (mergeWasInProgress(input.itemState, input.checkpoint)) return { type: "reverify" };
  if (input.runnerHoldsWork && input.itemState === "verifying") return { type: "reverify" };
  if (input.runnerHoldsWork)
    return { type: "resume", freshSession: true, checkpoint: input.checkpoint, reattach: true };
  if (input.recoveryAttempts >= 1 && (input.sinceResumeMs ?? 0) < RESUME_AGAIN_AFTER_MS)
    return { type: "ask_restart" };
  if (input.itemState === "verifying" && hasVerificationCandidate(input.checkpoint))
    return { type: "reverify", resumed: true };
  return { type: "resume", freshSession: true, checkpoint: input.checkpoint };
}
