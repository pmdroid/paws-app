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
  "merge_accepted",
  "rebase_high_risk",
  "ejected",
  "train_budget_used",
  "requeue",
  "take_over",
  "human_completed",
  "answer_completed",
  "cancel",
] as const;

export type WorkItemEvent = (typeof WORK_ITEM_EVENTS)[number];

/** Epic states. Budget hold is a flag on the row, not a state. */
export const EPIC_STATES = [
  "planning",
  "awaiting_plan_approval",
  "running",
  "stalled",
  "done",
  "cancelled",
] as const;

export type EpicState = (typeof EPIC_STATES)[number];

export const TERMINAL_EPIC_STATES = ["done", "cancelled"] as const;

export type TerminalEpicState = (typeof TERMINAL_EPIC_STATES)[number];

export const EPIC_EVENTS = [
  "proposal_persisted",
  "request_changes",
  "plan_approved",
  "stalled",
  "resumed",
  "completed",
  "cancel",
] as const;

export type EpicEvent = (typeof EPIC_EVENTS)[number];

export function isTerminalWorkItemState(state: WorkItemState): state is TerminalWorkItemState {
  return state === "completed" || state === "merged" || state === "cancelled";
}

export function isTerminalEpicState(state: EpicState): state is TerminalEpicState {
  return state === "done" || state === "cancelled";
}
