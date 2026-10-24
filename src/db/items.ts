import type { Database } from "bun:sqlite";
import {
  awakeCategory,
  capActivityText,
  capReason,
  countsAwakeTime,
  formatAwakeBreakdown,
  timeLimitQuestion,
  TIME_LIMIT_EXTENSION_MS,
  TIME_LIMIT_OPTIONS,
  type AwakeBreakdown,
  type AwakeCategory,
  IN_FLIGHT_ITEM_STATES,
  isTerminalWorkItemState,
  JOB_KIND,
  OUTBOX_ACTIVITY,
  transition,
  type Checkpoint,
  type WorkItemEvent,
  type WorkItemState,
  type WorkBrief,
} from "../core";
import { cancelOpenJobs, enqueueJobOnce } from "./jobs";
import { journal } from "./journal";
import { enqueueOutboxOnce } from "./outbox";
import { getRun, markRun } from "./runs";
import { getConfirmedRemoteMerge } from "./remote-merges";
import { immediate } from "./tx";

export type WorkItemRecord = {
  id: string;
  taskKey?: string | null;
  delegationId: string;
  linearIssueId: string;
  linearIdentifier: string;
  title: string;
  state: WorkItemState;
  branchName: string;
  position: number;
  version: number;
  checkpoint: Checkpoint | null;
  recoveryAttempts: number;
  resumedAt: number | null;
  awakeMs: number;
  lastMonoMs: number | null;
  turnCount: number;
  maxTurns: number;
  maxAwakeMs: number;
  /** The head Closeout last accepted. Set until the task restarts from fresh main. */
  acceptedHead: string | null;
  agentMs: number;
  closeoutMs: number;
  waitingMs: number;
  recheckMs: number;
  cancelRequested: boolean;
  sessionKey: string | null;
  currentRunId: string | null;
  brief: WorkBrief | null;
};

type ItemSql = {
  id: string;
  task_key: string | null;
  delegation_id: string;
  linear_issue_id: string;
  linear_identifier: string;
  title: string;
  state: WorkItemState;
  branch_name: string;
  position: number;
  version: number;
  checkpoint: string | null;
  recovery_attempts: number;
  resumed_at: number | null;
  awake_ms: number;
  last_mono_ms: number | null;
  turn_count: number;
  max_turns: number;
  max_awake_ms: number;
  accepted_head: string | null;
  agent_ms: number;
  closeout_ms: number;
  waiting_ms: number;
  recheck_ms: number;
  cancel_requested: number;
  session_key: string | null;
  current_run_id: string | null;
  brief: string | null;
};

export class TransitionRejectedError extends Error {
  readonly reason: "illegal_transition" | "terminal";

  constructor(reason: "illegal_transition" | "terminal") {
    super(reason);
    this.name = "TransitionRejectedError";
    this.reason = reason;
  }
}

export function getWorkItem(db: Database, id: string): WorkItemRecord | null {
  const row = db.query<ItemSql, [string]>("SELECT * FROM work_item WHERE id = ?").get(id);
  return row === null ? null : mapItem(row);
}

export function listWorkItems(db: Database): WorkItemRecord[] {
  return db
    .query<ItemSql, []>("SELECT * FROM work_item ORDER BY created_at, id")
    .all()
    .map(mapItem);
}

export function listWorkItemsByStates(
  db: Database,
  states: readonly WorkItemState[],
): WorkItemRecord[] {
  if (states.length === 0) return [];
  const placeholders = states.map(() => "?").join(", ");
  return db
    .query<ItemSql, string[]>(
      `SELECT * FROM work_item WHERE state IN (${placeholders}) ORDER BY created_at, id`,
    )
    .all(...states)
    .map(mapItem);
}

export function listInFlightItems(db: Database): WorkItemRecord[] {
  return listWorkItemsByStates(db, IN_FLIGHT_ITEM_STATES);
}

/** The only writer of `work_item.state`. Throws when `transition` rejects the event. */
export function applyWorkItemEvent(db: Database, id: string, event: WorkItemEvent): WorkItemRecord {
  const current = getWorkItem(db, id);
  if (current === null) {
    throw new Error(`work item ${id} not found`);
  }
  const result = transition(current.state, event);
  if (!result.ok) {
    throw new TransitionRejectedError(result.reason);
  }
  const updated = db.run(
    "UPDATE work_item SET state = ?, version = version + 1 WHERE id = ? AND state = ?",
    [result.to, id, current.state],
  );
  if (updated.changes === 0) {
    throw new Error(`work item ${id} changed before ${event}`);
  }
  const next = getWorkItem(db, id);
  if (next === null) throw new Error(`work item ${id} not found`);
  journal(
    `transition ${next.linearIdentifier} ${current.state} --${event}--> ${next.state} v${next.version}`,
  );
  return next;
}

export function configureWorkItem(
  db: Database,
  id: string,
  patch: { sessionKey?: string; maxTurns?: number; maxAwakeMs?: number },
): void {
  if (patch.sessionKey !== undefined) {
    db.run("UPDATE work_item SET session_key = ? WHERE id = ?", [patch.sessionKey, id]);
  }
  if (patch.maxTurns !== undefined) {
    db.run("UPDATE work_item SET max_turns = ? WHERE id = ?", [patch.maxTurns, id]);
  }
  if (patch.maxAwakeMs !== undefined) {
    db.run("UPDATE work_item SET max_awake_ms = ? WHERE id = ?", [patch.maxAwakeMs, id]);
  }
}

export function saveCheckpoint(db: Database, id: string, checkpoint: Checkpoint | null): void {
  db.run("UPDATE work_item SET checkpoint = ? WHERE id = ?", [
    checkpoint === null ? null : JSON.stringify(checkpoint),
    id,
  ]);
}

export function setRecoveryAttempts(db: Database, id: string, attempts: number): void {
  db.run("UPDATE work_item SET recovery_attempts = ? WHERE id = ?", [attempts, id]);
}

export function markResumed(db: Database, id: string, now: number): void {
  db.run("UPDATE work_item SET recovery_attempts = 1, resumed_at = ? WHERE id = ?", [now, id]);
}

export function setCurrentRun(db: Database, id: string, runId: string | null): void {
  db.run("UPDATE work_item SET current_run_id = ? WHERE id = ?", [runId, id]);
}

export function clearProgress(db: Database, id: string): void {
  db.run(
    `UPDATE work_item
     SET checkpoint = NULL,
         recovery_attempts = 0,
         awake_ms = 0,
         agent_ms = 0,
         closeout_ms = 0,
         waiting_ms = 0,
         recheck_ms = 0,
         accepted_head = NULL,
         last_mono_ms = NULL,
         turn_count = 0,
         cancel_requested = 0,
         current_run_id = NULL
     WHERE id = ?`,
    [id],
  );
}

export function syncClock(db: Database, id: string, mono: number): void {
  db.run("UPDATE work_item SET last_mono_ms = ? WHERE id = ?", [mono, id]);
}

export type CapOutcome = {
  /** The task failed on its cap. */
  capped: boolean;
  /** Closeout had accepted the work, so the cap asked in Linear instead of failing. */
  asked?: boolean;
  /** The agent's run ended at the time limit: the caller must stop the live agent. */
  stopAgent?: boolean;
  item: WorkItemRecord;
};

export function recordTurn(db: Database, id: string, now = Date.now()): CapOutcome {
  return immediate(db, () => {
    const current = getWorkItem(db, id);
    if (current === null) throw new Error(`work item ${id} not found`);
    if (
      current.state === "failed" ||
      current.state === "cancelled" ||
      current.state === "merged" ||
      current.state === "completed"
    ) {
      return { capped: current.cancelRequested, item: current };
    }
    db.run("UPDATE work_item SET turn_count = turn_count + 1 WHERE id = ?", [id]);
    return enforceCaps(db, id, now, { stopsAgent: false });
  });
}

const BREAKDOWN_COLUMN: Record<AwakeCategory, string> = {
  agent: "agent_ms",
  closeout: "closeout_ms",
  waiting: "waiting_ms",
  recheck: "recheck_ms",
};

export function accrueAwake(db: Database, id: string, mono: number, now = Date.now()): CapOutcome {
  return immediate(db, () => {
    const current = getWorkItem(db, id);
    if (current === null) throw new Error(`work item ${id} not found`);
    const delta = current.lastMonoMs === null ? 0 : Math.max(0, mono - current.lastMonoMs);
    const category = awakeCategory(current.state, current.checkpoint, current.acceptedHead);
    const awake = countsAwakeTime(current.state, current.checkpoint, current.acceptedHead);
    const awakeMs = current.awakeMs + (awake ? delta : 0);
    db.run("UPDATE work_item SET awake_ms = ?, last_mono_ms = ? WHERE id = ?", [awakeMs, mono, id]);
    if (category !== null && delta > 0) {
      const column = BREAKDOWN_COLUMN[category];
      db.run(`UPDATE work_item SET ${column} = ${column} + ? WHERE id = ?`, [delta, id]);
    }
    if (!awake) {
      const updated = getWorkItem(db, id);
      if (updated === null) throw new Error(`work item ${id} not found`);
      return { capped: false, item: updated };
    }
    return enforceCaps(db, id, now);
  });
}

/**
 * Fails an item past a cap. Work Closeout already accepted never fails on the time
 * cap: Paws keeps publishing and merging it, and a resumed agent asks in Linear.
 */
function enforceCaps(
  db: Database,
  id: string,
  now: number,
  options: { stopsAgent: boolean } = { stopsAgent: true },
): CapOutcome {
  const updated = getWorkItem(db, id);
  if (updated === null) throw new Error(`work item ${id} not found`);
  const reason = capReason({
    turnCount: updated.turnCount,
    maxTurns: updated.maxTurns,
    awakeMs: updated.awakeMs,
    maxAwakeMs: updated.maxAwakeMs,
  });
  if (reason === null) return { capped: false, item: updated };
  if (reason === "time" && updated.acceptedHead !== null) {
    if (updated.state !== "running") return { capped: false, item: updated };
    // Asking or pausing ends the run, so only a caller that stops the live agent
    // (the host supervisor, through accrueAwake) may do it. It asks on its next tick.
    if (!options.stopsAgent) return { capped: false, item: updated };
    if (askTimeLimit(db, updated, now))
      return { capped: false, asked: true, stopAgent: true, item: refetch() };
    pauseAtTimeLimit(db, updated, now);
    return { capped: false, stopAgent: true, item: refetch() };
  }
  failForCap(db, updated, reason, now);
  return { capped: true, item: refetch() };

  function refetch(): WorkItemRecord {
    const item = getWorkItem(db, id);
    if (item === null) throw new Error(`work item ${id} not found`);
    return item;
  }
}

export function awakeBreakdown(item: WorkItemRecord): AwakeBreakdown {
  return {
    agentMs: item.agentMs,
    closeoutMs: item.closeoutMs,
    waitingMs: item.waitingMs,
    recheckMs: item.recheckMs,
  };
}

/** Closeout accepted `head`. The time cap no longer fails this task. */
export function markCloseoutAccepted(db: Database, id: string, head: string): void {
  db.run("UPDATE work_item SET accepted_head = ? WHERE id = ?", [head, id]);
}

/** A Continue answer to the time-limit question gives the agent more awake time. */
export function extendAwakeCap(db: Database, id: string, extraMs = TIME_LIMIT_EXTENSION_MS): void {
  db.run("UPDATE work_item SET max_awake_ms = MAX(max_awake_ms, awake_ms) + ? WHERE id = ?", [
    extraMs,
    id,
  ]);
}

/** Zeroes the awake clock and its breakdown when a stopped task is started again. */
export function resetAwakeTime(db: Database, id: string): void {
  db.run(
    `UPDATE work_item
     SET awake_ms = 0, agent_ms = 0, closeout_ms = 0, waiting_ms = 0, recheck_ms = 0,
         last_mono_ms = NULL
     WHERE id = ?`,
    [id],
  );
}

/**
 * Cancels the agent's pending start and resume jobs at the time limit. Merge jobs
 * stay: Closeout accepted this work, so Paws keeps publishing and merging it.
 */
function cancelAgentJobs(db: Database, itemId: string, now: number): void {
  db.run(
    `UPDATE job
     SET status = 'cancelled', last_error = 'time_limit', locked_by = NULL,
         locked_until = NULL, finished_at = ?
     WHERE status IN ('pending', 'running') AND queue IN (?, ?)
       AND json_extract(payload, '$.itemId') = ?`,
    [now, JOB_KIND.start, JOB_KIND.resume, itemId],
  );
}

/**
 * Without a Linear session to ask in, accepted work pauses at the time limit
 * instead of failing. The cap already allows another hour, so resuming it from
 * the run page keeps going.
 */
function pauseAtTimeLimit(db: Database, item: WorkItemRecord, now: number): void {
  applyWorkItemEvent(db, item.id, "pause");
  cancelAgentJobs(db, item.id, now);
  if (item.currentRunId !== null) {
    const run = getRun(db, item.currentRunId);
    if (run?.status === "active") markRun(db, run.id, "ended", now);
  }
  extendAwakeCap(db, item.id);
  journal(`item ${item.linearIdentifier} reached its time cap after acceptance; paused`);
  enqueueOutboxOnce(db, {
    target: OUTBOX_ACTIVITY.target,
    op: OUTBOX_ACTIVITY.op,
    orderingKey: item.id,
    idempotencyKey: `time-limit-pause:${item.id}:${item.version}`,
    payload: { sessionId: item.id, kind: "thought", body: timeLimitPausedNote(item) },
    now,
  });
}

function timeLimitPausedNote(item: WorkItemRecord): string {
  return `Paused at the time limit. Closeout already accepted this task's work, so Paws did not fail it. ${formatAwakeBreakdown(awakeBreakdown(item))} Resume it from the run page to give the agent another hour.`;
}

/**
 * Stops the resumed agent's run and asks "continue or stop?" in Linear.
 * Returns false when the task has no Linear session to ask in.
 */
function askTimeLimit(db: Database, item: WorkItemRecord, now: number): boolean {
  const sessionId = item.sessionKey;
  if (sessionId === null) return false;
  const waits =
    db
      .query(
        "SELECT 1 FROM question WHERE session_id = ? AND status = 'open' AND cancelled_at IS NULL",
      )
      .get(sessionId) !== null;
  cancelAgentJobs(db, item.id, now);
  applyWorkItemEvent(db, item.id, "blocking_question");
  if (item.checkpoint) saveCheckpoint(db, item.id, { ...item.checkpoint, phase: "awaiting_input" });
  if (item.currentRunId !== null) {
    const run = getRun(db, item.currentRunId);
    if (run?.status === "active") markRun(db, run.id, "ended", now);
  }
  const questionId = crypto.randomUUID();
  const body = timeLimitQuestion(item.maxAwakeMs, awakeBreakdown(item));
  const options = [...TIME_LIMIT_OPTIONS];
  db.run(
    `INSERT INTO question (id, item_id, run_id, session_id, kind, body, options, status, created_at)
     VALUES (?, ?, ?, ?, 'time-limit', ?, ?, ?, ?)`,
    [
      questionId,
      item.id,
      item.currentRunId,
      sessionId,
      body,
      JSON.stringify(options),
      waits ? "queued" : "open",
      now,
    ],
  );
  journal(`item ${item.linearIdentifier} reached its time cap after acceptance; asked in Linear`);
  if (!waits)
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: sessionId,
      idempotencyKey: `question:${questionId}`,
      payload: { id: questionId, sessionId, questionId, body, options },
      now,
    });
  return true;
}

export function failWorkItem(
  db: Database,
  item: WorkItemRecord,
  reason: string,
  text: string,
  now: number,
): boolean {
  return immediate(db, () => {
    const current = getWorkItem(db, item.id);
    if (
      current === null ||
      current.version !== item.version ||
      current.currentRunId !== item.currentRunId ||
      current.state === "failed" ||
      isTerminalWorkItemState(current.state)
    )
      return false;
    commitFailure(
      db,
      current,
      reason,
      text,
      now,
      (version) => `fail:${item.id}:${version}:${reason}`,
    );
    return true;
  });
}

export function completeMergedItem(
  db: Database,
  input: {
    itemId: string;
    now: number;
    announce?: (item: WorkItemRecord) => void;
  },
): WorkItemRecord | null {
  return immediate(db, () => {
    const current = getWorkItem(db, input.itemId);
    if (
      current === null ||
      current.state !== "merge_queue" ||
      current.cancelRequested ||
      getConfirmedRemoteMerge(db, current.id) === null
    )
      return null;
    input.announce?.(current);
    const merged = applyWorkItemEvent(db, current.id, "merge_accepted");
    endActiveRun(db, current.currentRunId, input.now);
    cancelAdvancingJobs(db, current.id, "merged", input.now);
    return merged;
  });
}

function endActiveRun(db: Database, runId: string | null, now: number): void {
  if (runId === null) return;
  const run = getRun(db, runId);
  if (run && (run.status === "active" || run.status === "provisioning"))
    markRun(db, runId, "ended", now);
}

export function cancelAdvancingJobs(
  db: Database,
  itemId: string,
  reason: string,
  now: number,
): void {
  db.run(
    `UPDATE job SET status = 'cancelled', last_error = ?, finished_at = ?
     WHERE status = 'pending' AND json_extract(payload, '$.itemId') = ?
       AND (queue IN (?, ?, ?) OR queue = ? OR queue LIKE ?)`,
    [
      reason,
      now,
      itemId,
      JOB_KIND.start,
      JOB_KIND.resume,
      JOB_KIND.reverify,
      JOB_KIND.merge,
      `${JOB_KIND.merge}.%`,
    ],
  );
}

export function deferWorkItem(
  db: Database,
  item: WorkItemRecord,
  input: {
    retry: number;
    delayMs: number;
    handoff: string | null;
    message: string | null;
    now: number;
    capacityWait?: RunnerCapacityWaitState;
  },
): void {
  immediate(db, () => {
    if (item.state === "running" || item.state === "verifying")
      applyWorkItemEvent(db, item.id, "lease_expired");
    const current = getWorkItem(db, item.id) ?? item;
    journal(`item ${item.linearIdentifier} deferred: retry ${input.retry} in ${input.delayMs} ms`);
    if (current.currentRunId !== null) {
      const run = getRun(db, current.currentRunId);
      if (run && (run.status === "active" || run.status === "provisioning"))
        markRun(db, run.id, "lost", input.now);
    }
    enqueueJobOnce(db, {
      queue: JOB_KIND.resume,
      jobKey: `resume:${item.id}:${current.version}`,
      runAt: input.now + input.delayMs,
      payload: {
        itemId: item.id,
        runId: current.currentRunId,
        reason: "transient_failure",
        retry: input.retry,
        ...(input.handoff === null ? {} : { handoff: input.handoff }),
        ...(input.capacityWait ? { capacityWait: input.capacityWait } : {}),
      },
      now: input.now,
    });
    if (input.message !== null)
      enqueueOutboxOnce(db, {
        target: OUTBOX_ACTIVITY.target,
        op: OUTBOX_ACTIVITY.op,
        orderingKey: item.sessionKey ?? item.id,
        idempotencyKey: `retry:${item.id}:${current.version}`,
        payload: { sessionId: item.sessionKey ?? item.id, kind: "thought", body: input.message },
        now: input.now,
      });
  });
}

export type RunnerCapacityWaitState = {
  since: number;
  attempt: number;
  runnerIds: readonly string[];
  holdMs?: number;
};

export function runnerCapacityWait(payload: unknown): RunnerCapacityWaitState | null {
  const wait = (payload as { capacityWait?: Partial<RunnerCapacityWaitState> } | null)
    ?.capacityWait;
  return typeof wait?.since === "number" &&
    typeof wait.attempt === "number" &&
    Array.isArray(wait.runnerIds)
    ? {
        since: wait.since,
        attempt: wait.attempt,
        runnerIds: wait.runnerIds,
        ...(typeof wait.holdMs === "number" ? { holdMs: wait.holdMs } : {}),
      }
    : null;
}

function failForCap(
  db: Database,
  item: WorkItemRecord,
  reason: "turns" | "time",
  now: number,
): void {
  commitFailure(
    db,
    item,
    `cap:${reason}`,
    capActivityText(reason, item.maxTurns, item.maxAwakeMs, awakeBreakdown(item)),
    now,
    (version) => `cap:${item.id}:${version}:${reason}`,
  );
}

function commitFailure(
  db: Database,
  item: WorkItemRecord,
  reason: string,
  text: string,
  now: number,
  idempotencyKey: (version: number) => string,
): void {
  const version = moveToFailed(db, item);
  journal(`item ${item.linearIdentifier} failed: ${reason}`);
  db.run("UPDATE work_item SET cancel_requested = 1 WHERE id = ?", [item.id]);
  if (item.currentRunId !== null) markRun(db, item.currentRunId, "lost", now);
  cancelOpenJobs(db, { itemId: item.id, reason, now });
  enqueueOutboxOnce(db, {
    target: OUTBOX_ACTIVITY.target,
    op: OUTBOX_ACTIVITY.op,
    orderingKey: item.sessionKey ?? item.id,
    idempotencyKey: idempotencyKey(version),
    payload: { sessionId: item.sessionKey ?? item.id, kind: "error", body: text },
    now,
  });
}

function moveToFailed(db: Database, item: WorkItemRecord): number {
  if (item.state === "failed") return item.version;
  if (item.state === "merge_queue") {
    applyWorkItemEvent(db, item.id, "lease_expired");
    return applyWorkItemEvent(db, item.id, "closeout_infra_failed").version;
  }
  const event = failureEvent(item.state);
  if (event === null) {
    throw new TransitionRejectedError("illegal_transition");
  }
  return applyWorkItemEvent(db, item.id, event).version;
}

function failureEvent(state: WorkItemState): WorkItemEvent | null {
  switch (state) {
    case "running":
      return "run_failed";
    case "verifying":
      return "closeout_infra_failed";
    case "recovering":
      return "crash_budget_used";
    case "queued":
      return "start_timed_out";
    default:
      return null;
  }
}

function mapItem(row: ItemSql): WorkItemRecord {
  return {
    id: row.id,
    taskKey: row.task_key,
    delegationId: row.delegation_id,
    linearIssueId: row.linear_issue_id,
    linearIdentifier: row.linear_identifier,
    title: row.title,
    state: row.state,
    branchName: row.branch_name,
    position: row.position,
    version: row.version,
    checkpoint: parseCheckpoint(row.checkpoint),
    recoveryAttempts: row.recovery_attempts,
    resumedAt: row.resumed_at,
    awakeMs: row.awake_ms,
    lastMonoMs: row.last_mono_ms,
    turnCount: row.turn_count,
    maxTurns: row.max_turns,
    maxAwakeMs: row.max_awake_ms,
    acceptedHead: row.accepted_head ?? null,
    agentMs: row.agent_ms ?? 0,
    closeoutMs: row.closeout_ms ?? 0,
    waitingMs: row.waiting_ms ?? 0,
    recheckMs: row.recheck_ms ?? 0,
    cancelRequested: row.cancel_requested === 1,
    sessionKey: row.session_key,
    currentRunId: row.current_run_id,
    brief: row.brief === null ? null : (JSON.parse(row.brief) as WorkBrief),
  };
}

function parseCheckpoint(value: string | null): Checkpoint | null {
  if (value === null) return null;
  return JSON.parse(value) as Checkpoint;
}
