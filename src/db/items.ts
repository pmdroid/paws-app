import type { Database } from "bun:sqlite";
import {
  capActivityText,
  capReason,
  isAwakeItemState,
  OUTBOX_ACTIVITY,
  transition,
  type Checkpoint,
  type WorkItemEvent,
  type WorkItemState,
  type WorkBrief,
} from "../core";
import { cancelOpenJobs } from "./jobs";
import { enqueueOutboxOnce } from "./outbox";
import { markRun } from "./runs";
import { immediate } from "./tx";

export type WorkItemRecord = {
  id: string;
  taskKey?: string | null;
  epicId: string;
  linearIssueId: string;
  linearIdentifier: string;
  title: string;
  state: WorkItemState;
  branchName: string;
  position: number;
  version: number;
  checkpoint: Checkpoint | null;
  recoveryAttempts: number;
  awakeMs: number;
  lastMonoMs: number | null;
  turnCount: number;
  maxTurns: number;
  maxAwakeMs: number;
  cancelRequested: boolean;
  sessionKey: string | null;
  currentRunId: string | null;
  brief: WorkBrief | null;
};

type ItemSql = {
  id: string;
  task_key: string | null;
  epic_id: string;
  linear_issue_id: string;
  linear_identifier: string;
  title: string;
  state: WorkItemState;
  branch_name: string;
  position: number;
  version: number;
  checkpoint: string | null;
  recovery_attempts: number;
  awake_ms: number;
  last_mono_ms: number | null;
  turn_count: number;
  max_turns: number;
  max_awake_ms: number;
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
  return listWorkItemsByStates(db, [
    "running",
    "verifying",
    "recovering",
    "awaiting_input",
    "paused",
    "merge_queue",
  ]);
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

export function setCurrentRun(db: Database, id: string, runId: string | null): void {
  db.run("UPDATE work_item SET current_run_id = ? WHERE id = ?", [runId, id]);
}

export function clearProgress(db: Database, id: string): void {
  db.run(
    `UPDATE work_item
     SET checkpoint = NULL,
         recovery_attempts = 0,
         awake_ms = 0,
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

export function recordTurn(
  db: Database,
  id: string,
  now = Date.now(),
): { capped: boolean; item: WorkItemRecord } {
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
    const updated = getWorkItem(db, id);
    if (updated === null) throw new Error(`work item ${id} not found`);
    const reason = capReason({
      turnCount: updated.turnCount,
      maxTurns: updated.maxTurns,
      awakeMs: updated.awakeMs,
      maxAwakeMs: updated.maxAwakeMs,
    });
    if (reason === null) return { capped: false, item: updated };
    failForCap(db, updated, reason, now);
    const failed = getWorkItem(db, id);
    if (failed === null) throw new Error(`work item ${id} not found`);
    return { capped: true, item: failed };
  });
}

export function accrueAwake(
  db: Database,
  id: string,
  mono: number,
  now = Date.now(),
): { capped: boolean; item: WorkItemRecord } {
  return immediate(db, () => {
    const current = getWorkItem(db, id);
    if (current === null) throw new Error(`work item ${id} not found`);
    const delta = current.lastMonoMs === null ? 0 : Math.max(0, mono - current.lastMonoMs);
    const awake = isAwakeItemState(current.state);
    const awakeMs = current.awakeMs + (awake ? delta : 0);
    db.run("UPDATE work_item SET awake_ms = ?, last_mono_ms = ? WHERE id = ?", [awakeMs, mono, id]);
    const updated = getWorkItem(db, id);
    if (updated === null) throw new Error(`work item ${id} not found`);
    if (!awake) return { capped: false, item: updated };
    const reason = capReason({
      turnCount: updated.turnCount,
      maxTurns: updated.maxTurns,
      awakeMs: updated.awakeMs,
      maxAwakeMs: updated.maxAwakeMs,
    });
    if (reason === null) return { capped: false, item: updated };
    failForCap(db, updated, reason, now);
    const failed = getWorkItem(db, id);
    if (failed === null) throw new Error(`work item ${id} not found`);
    return { capped: true, item: failed };
  });
}

export function failWorkItem(
  db: Database,
  item: WorkItemRecord,
  reason: string,
  text: string,
  now: number,
): void {
  moveToFailed(db, item);
  db.run("UPDATE work_item SET cancel_requested = 1 WHERE id = ?", [item.id]);
  if (item.currentRunId !== null) markRun(db, item.currentRunId, "lost", now);
  cancelOpenJobs(db, { itemId: item.id, reason, now });
  enqueueOutboxOnce(db, {
    target: OUTBOX_ACTIVITY.target,
    op: OUTBOX_ACTIVITY.op,
    orderingKey: item.sessionKey ?? item.id,
    idempotencyKey: `fail:${item.id}:${reason}`,
    payload: { sessionId: item.sessionKey ?? item.id, kind: "error", body: text },
    now,
  });
}

function failForCap(
  db: Database,
  item: WorkItemRecord,
  reason: "turns" | "time",
  now: number,
): void {
  moveToFailed(db, item);
  db.run("UPDATE work_item SET cancel_requested = 1 WHERE id = ?", [item.id]);
  if (item.currentRunId !== null) markRun(db, item.currentRunId, "lost", now);
  cancelOpenJobs(db, { itemId: item.id, reason: `cap:${reason}`, now });
  enqueueOutboxOnce(db, {
    target: OUTBOX_ACTIVITY.target,
    op: OUTBOX_ACTIVITY.op,
    orderingKey: item.sessionKey ?? item.id,
    idempotencyKey: `cap:${item.id}:${reason}`,
    payload: {
      sessionId: item.sessionKey ?? item.id,
      kind: "error",
      body: capActivityText(reason, item.maxTurns, item.maxAwakeMs),
    },
    now,
  });
}

function moveToFailed(db: Database, item: WorkItemRecord): void {
  if (item.state === "failed") return;
  if (item.state === "merge_queue") {
    applyWorkItemEvent(db, item.id, "lease_expired");
    applyWorkItemEvent(db, item.id, "closeout_infra_failed");
    return;
  }
  const event = failureEvent(item.state);
  if (event === null) {
    throw new TransitionRejectedError("illegal_transition");
  }
  applyWorkItemEvent(db, item.id, event);
}

function failureEvent(state: WorkItemState): WorkItemEvent | null {
  switch (state) {
    case "running":
      return "run_failed";
    case "verifying":
      return "closeout_infra_failed";
    case "recovering":
      return "crash_budget_used";
    default:
      return null;
  }
}

function mapItem(row: ItemSql): WorkItemRecord {
  return {
    id: row.id,
    taskKey: row.task_key,
    epicId: row.epic_id,
    linearIssueId: row.linear_issue_id,
    linearIdentifier: row.linear_identifier,
    title: row.title,
    state: row.state,
    branchName: row.branch_name,
    position: row.position,
    version: row.version,
    checkpoint: parseCheckpoint(row.checkpoint),
    recoveryAttempts: row.recovery_attempts,
    awakeMs: row.awake_ms,
    lastMonoMs: row.last_mono_ms,
    turnCount: row.turn_count,
    maxTurns: row.max_turns,
    maxAwakeMs: row.max_awake_ms,
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
