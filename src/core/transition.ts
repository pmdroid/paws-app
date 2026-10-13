import {
  isTerminalEpicState,
  isTerminalWorkItemState,
  type EpicEvent,
  type EpicState,
  type WorkItemEvent,
  type WorkItemState,
} from "./states";

export type TransitionOk<State extends string, Event extends string> = {
  ok: true;
  from: State;
  to: State;
  event: Event;
};

export type TransitionErr<State extends string, Event extends string> = {
  ok: false;
  from: State;
  event: Event;
  reason: "illegal_transition" | "terminal";
};

export type TransitionResult<State extends string, Event extends string> =
  | TransitionOk<State, Event>
  | TransitionErr<State, Event>;

type Edge<State extends string, Event extends string> = {
  from: State;
  event: Event;
  to: State;
};

/**
 * Legal work-item edges. `cancel` is not listed: it leaves every non-terminal state.
 * High-risk acceptance is its own event so this module does not learn risk policy.
 */
export const WORK_ITEM_EDGES: readonly Edge<WorkItemState, WorkItemEvent>[] = [
  { from: "planning", event: "plan_approved", to: "queued" },
  { from: "queued", event: "dispatched", to: "running" },
  { from: "running", event: "blocking_question", to: "awaiting_input" },
  { from: "verifying", event: "blocking_question", to: "awaiting_input" },
  { from: "merge_queue", event: "blocking_question", to: "awaiting_input" },
  { from: "awaiting_input", event: "answer_received", to: "running" },
  { from: "running", event: "pause", to: "paused" },
  { from: "paused", event: "resume", to: "running" },
  { from: "running", event: "lease_expired", to: "recovering" },
  { from: "verifying", event: "lease_expired", to: "recovering" },
  { from: "merge_queue", event: "lease_expired", to: "verifying" },
  { from: "running", event: "restart", to: "queued" },
  { from: "paused", event: "restart", to: "queued" },
  { from: "awaiting_input", event: "restart", to: "queued" },
  { from: "recovering", event: "restart", to: "queued" },
  { from: "verifying", event: "restart", to: "queued" },
  { from: "merge_queue", event: "restart", to: "queued" },
  { from: "recovering", event: "recovered", to: "running" },
  { from: "recovering", event: "crash_budget_used", to: "failed" },
  { from: "running", event: "turn_ended", to: "verifying" },
  { from: "running", event: "answer_completed", to: "completed" },
  { from: "running", event: "artifact_completed", to: "completed" },
  { from: "running", event: "run_failed", to: "failed" },
  { from: "verifying", event: "closeout_rejected", to: "running" },
  { from: "verifying", event: "commit_while_verifying", to: "verifying" },
  { from: "verifying", event: "closeout_exhausted", to: "exhausted" },
  { from: "verifying", event: "closeout_infra_failed", to: "failed" },
  { from: "verifying", event: "closeout_accepted", to: "merge_queue" },
  { from: "verifying", event: "closeout_accepted_high_risk", to: "awaiting_signoff" },
  { from: "awaiting_signoff", event: "signed_off", to: "merge_queue" },
  { from: "awaiting_signoff", event: "changes_requested", to: "running" },
  { from: "awaiting_signoff", event: "signoff_sla_expired", to: "manual" },
  { from: "merge_queue", event: "main_moved", to: "merge_queue" },
  { from: "merge_queue", event: "reverify_requested", to: "verifying" },
  { from: "merge_queue", event: "merge_accepted", to: "merged" },
  { from: "merge_queue", event: "rebase_high_risk", to: "awaiting_signoff" },
  { from: "merge_queue", event: "ejected", to: "running" },
  { from: "merge_queue", event: "train_budget_used", to: "exhausted" },
  { from: "exhausted", event: "requeue", to: "queued" },
  { from: "exhausted", event: "take_over", to: "manual" },
  { from: "failed", event: "requeue", to: "queued" },
  { from: "failed", event: "take_over", to: "manual" },
  { from: "manual", event: "human_completed", to: "merged" },
];

export const EPIC_EDGES: readonly Edge<EpicState, EpicEvent>[] = [
  { from: "planning", event: "proposal_persisted", to: "awaiting_plan_approval" },
  { from: "awaiting_plan_approval", event: "request_changes", to: "planning" },
  { from: "awaiting_plan_approval", event: "plan_approved", to: "running" },
  { from: "running", event: "stalled", to: "stalled" },
  { from: "stalled", event: "resumed", to: "running" },
  { from: "running", event: "completed", to: "done" },
  { from: "stalled", event: "completed", to: "done" },
];

const workItemTable = edgeTable(WORK_ITEM_EDGES);
const epicTable = edgeTable(EPIC_EDGES);

/**
 * The only way a work item changes state. Pure: no database and no side effects.
 * Persistence, outbox rows, and jobs belong in the same transaction as the caller.
 */
export function transition(
  state: WorkItemState,
  event: WorkItemEvent,
): TransitionResult<WorkItemState, WorkItemEvent> {
  if (event === "cancel") {
    if (isTerminalWorkItemState(state)) {
      return { ok: false, from: state, event, reason: "terminal" };
    }
    return { ok: true, from: state, to: "cancelled", event };
  }
  return lookup(workItemTable, state, event);
}

/** Epic-level machine. Intake of human-written sub-issues creates the epic already `running`. */
export function transitionEpic(
  state: EpicState,
  event: EpicEvent,
): TransitionResult<EpicState, EpicEvent> {
  if (event === "cancel") {
    if (isTerminalEpicState(state)) {
      return { ok: false, from: state, event, reason: "terminal" };
    }
    return { ok: true, from: state, to: "cancelled", event };
  }
  return lookup(epicTable, state, event);
}

function edgeTable<State extends string, Event extends string>(
  edges: readonly Edge<State, Event>[],
): Map<string, State> {
  const table = new Map<string, State>();
  for (const edge of edges) {
    const key = edgeKey(edge.from, edge.event);
    if (table.has(key)) {
      throw new Error(`duplicate transition ${key}`);
    }
    table.set(key, edge.to);
  }
  return table;
}

function lookup<State extends string, Event extends string>(
  table: Map<string, State>,
  state: State,
  event: Event,
): TransitionResult<State, Event> {
  const to = table.get(edgeKey(state, event));
  if (to === undefined) {
    return { ok: false, from: state, event, reason: "illegal_transition" };
  }
  return { ok: true, from: state, to, event };
}

function edgeKey(state: string, event: string): string {
  return `${state}|${event}`;
}
