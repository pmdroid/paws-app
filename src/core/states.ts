import type { TaskMode } from "./task";

/** Work-item states. The `work_item.state` CHECK list must match this union. */
export const WORK_ITEM_STATES = [
  "planning",
  "queued",
  "running",
  "paused",
  "awaiting_input",
  "recovering",
  "verifying",
  "exhausted",
  "failed",
  "awaiting_signoff",
  "merge_queue",
  "manual",
  "completed",
  "merged",
  "cancelled",
] as const;

export type WorkItemState = (typeof WORK_ITEM_STATES)[number];

export const TERMINAL_WORK_ITEM_STATES = ["completed", "merged", "cancelled"] as const;

export type TerminalWorkItemState = (typeof TERMINAL_WORK_ITEM_STATES)[number];

export const IN_FLIGHT_ITEM_STATES = [
  "running",
  "verifying",
  "recovering",
  "awaiting_input",
  "paused",
  "merge_queue",
] as const satisfies readonly WorkItemState[];

/** Events the work-item machine accepts. `cancel` is legal from every non-terminal state. */
export const WORK_ITEM_EVENTS = [
  "plan_approved",
  "dispatched",
  "blocking_question",
  "answer_received",
  "pause",
  "resume",
  "restart",
  "lease_expired",
  "recovered",
  "crash_budget_used",
  "turn_ended",
  "run_failed",
  "closeout_rejected",
  "commit_while_verifying",
  "closeout_exhausted",
  "closeout_infra_failed",
  "closeout_accepted",
  "closeout_accepted_high_risk",
  "signed_off",
  "changes_requested",
  "signoff_sla_expired",
  "main_moved",
  "reverify_requested",
  "merge_accepted",
  "rebase_high_risk",
  "ejected",
  "train_budget_used",
  "requeue",
  "take_over",
  "human_completed",
  "answer_completed",
  "artifact_completed",
  "cancel",
  "start_timed_out",
] as const;

export type WorkItemEvent = (typeof WORK_ITEM_EVENTS)[number];

/** Epic states. Budget hold is a flag on the row, not a state. */
export const DELEGATION_STATES = [
  "planning",
  "awaiting_plan_approval",
  "running",
  "stalled",
  "done",
  "cancelled",
] as const;

export type DelegationState = (typeof DELEGATION_STATES)[number];

export function isTerminalWorkItemState(state: WorkItemState): state is TerminalWorkItemState {
  return state === "completed" || state === "merged" || state === "cancelled";
}

export function isBlockerSatisfied(blocker: {
  state: WorkItemState;
  mode: TaskMode | null;
}): boolean {
  return (
    blocker.state === "merged" ||
    (blocker.state === "completed" && (blocker.mode === "answer" || blocker.mode === "artifact"))
  );
}

export function holdsExecution(row: {
  state: WorkItemState;
  liveRun: boolean;
  liveJob: boolean;
}): boolean {
  return (
    row.liveRun ||
    row.liveJob ||
    row.state === "running" ||
    row.state === "verifying" ||
    row.state === "recovering"
  );
}
