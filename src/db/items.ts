import type { Database } from "bun:sqlite";
import {
  capActivityText,
  capReason,
  isAwakeItemState,
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
  const version = moveToFailed(db, item);
  journal(`item ${item.linearIdentifier} failed: ${reason}`);
  db.run("UPDATE work_item SET cancel_requested = 1 WHERE id = ?", [item.id]);
  if (item.currentRunId !== null) markRun(db, item.currentRunId, "lost", now);
  cancelOpenJobs(db, { itemId: item.id, reason, now });
  enqueueOutboxOnce(db, {
    target: OUTBOX_ACTIVITY.target,
    op: OUTBOX_ACTIVITY.op,
    orderingKey: item.sessionKey ?? item.id,
    idempotencyKey: `fail:${item.id}:${version}:${reason}`,
    payload: { sessionId: item.sessionKey ?? item.id, kind: "error", body: text },
    now,
  });
}

export function deferWorkItem(
  db: Database,
  item: WorkItemRecord,
  input: { retry: number; delayMs: number; handoff: string | null; message: string; now: number },
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
      },
      now: input.now,
    });
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

function failForCap(
  db: Database,
  item: WorkItemRecord,
  reason: "turns" | "time",
  now: number,
): void {
  const version = moveToFailed(db, item);
  journal(`item ${item.linearIdentifier} failed: ${reason}`);
  db.run("UPDATE work_item SET cancel_requested = 1 WHERE id = ?", [item.id]);
  if (item.currentRunId !== null) markRun(db, item.currentRunId, "lost", now);
  journal(`item ${item.linearIdentifier} failed: cap:${reason}`);
  cancelOpenJobs(db, { itemId: item.id, reason: `cap:${reason}`, now });
  enqueueOutboxOnce(db, {
    target: OUTBOX_ACTIVITY.target,
    op: OUTBOX_ACTIVITY.op,
    orderingKey: item.sessionKey ?? item.id,
    idempotencyKey: `cap:${item.id}:${version}:${reason}`,
    payload: {
      sessionId: item.sessionKey ?? item.id,
      kind: "error",
      body: capActivityText(reason, item.maxTurns, item.maxAwakeMs),
    },
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
