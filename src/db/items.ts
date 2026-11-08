import { pendingRestartHandoff } from "./restart";
import type { Database } from "bun:sqlite";
import { desc, eq } from "drizzle-orm";
import { halt } from "./halt";
import { wakeMergesBehind } from "./merge-queue";
import { readCheckpoint } from "./checkpoint";
import {
  awakeCategory,
  agentStage,
  capActivityText,
  stageLimits,
  stageReached,
  formatAwakeBreakdown,
  timeLimitQuestion,
  unacceptedTimeLimitQuestion,
  TIME_LIMIT_EXTENSION_MS,
  TIME_LIMIT_OPTIONS,
  TIME_LIMIT_VERIFYING_REASON,
  UNACCEPTED_TIME_LIMIT_OPTIONS,
  type AwakeBreakdown,
  type AwakeCategory,
  type StageLimits,
  type TimeStage,
  hasVerificationCandidate,
  IN_FLIGHT_ITEM_STATES,
  isAwakeItemState,
  isTerminalWorkItemState,
  JOB_KIND,
  MAX_TRANSIENT_RETRIES,
  OUTBOX_ACTIVITY,
  transition,
  type Checkpoint,
  type RestartReason,
  type RecordedWorkItemEvent,
  type WorkItemEvent,
  type WorkItemEventKind,
  type WorkItemState,
  type WorkBrief,
} from "../core";
import { cancelOpenJobs, enqueueJobOnce, type Job } from "./jobs";
import { journal } from "./journal";
import { enqueueOutboxOnce } from "./outbox";
import { getLinearSessionGeneration } from "./linear-sessions";
import { withOpenFindings } from "./open-findings";
import { getRun, markRun, releaseRunCapacity } from "./runs";
import { endMergeCall, getConfirmedRemoteMerge, mergeStopRequested } from "./remote-merges";
import { orm } from "./orm";
import { getPullRequestDraft } from "./pull-request-drafts";
import { itemReconciliationRequest, workItem, workItemEvent } from "./schema";
import { immediate } from "./tx";
import { runnerLeaseCutoff } from "./runner-lease";

export type WorkItemRecord = {
  id: string;
  taskKey?: string | null;
  delegationId: string;
  linearIssueId: string;
  linearIdentifier: string;
  title: string;
  state: WorkItemState;
  branchName: string;
  /** The earlier item of the same issue whose branch and pull request this one continues. */
  continuesItemId?: string | null;
  /** The pushed branch this item took over, `paws/<key>`. */
  continuesBranch?: string | null;
  position: number;
  version: number;
  checkpoint: Checkpoint | null;
  recoveryAttempts: number;
  resumedAt: number | null;
  awakeMs: number;
  lastMonoMs: number | null;
  maxAwakeMs: number;
  maxFixMs: number;
  maxCloseoutMs: number;
  linearProjectId?: string | null;
  /** The head Closeout last accepted. Cleared when a later verdict on that work retires it. */
  acceptedHead: string | null;
  agentMs: number;
  implementMs: number;
  fixMs: number;
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
  continues_item_id?: string | null;
  continues_branch?: string | null;
  position: number;
  version: number;
  checkpoint: string | null;
  recovery_attempts: number;
  resumed_at: number | null;
  awake_ms: number;
  last_mono_ms: number | null;
  max_awake_ms: number;
  max_fix_ms?: number;
  max_closeout_ms?: number;
  linear_project_id?: string | null;
  accepted_head: string | null;
  agent_ms: number;
  implement_ms?: number;
  fix_ms?: number;
  closeout_ms: number;
  waiting_ms: number;
  recheck_ms: number;
  cancel_requested: number;
  session_key: string | null;
  current_run_id: string | null;
  brief: string | null;
};

/** Work item columns with the branch an item continues, from `item_continuation`. */
const CONTINUED_ITEM_COLUMNS = `work_item.*, continuation.previous_item_id AS continues_item_id,
  continuation.branch AS continues_branch
  FROM work_item LEFT JOIN item_continuation continuation ON continuation.item_id = work_item.id`;
const migratedContinuation = new WeakSet<Database>();

/** A database migrated only partway, as migration tests build, has no `item_continuation` yet. */
function itemColumns(db: Database): string {
  if (migratedContinuation.has(db)) return CONTINUED_ITEM_COLUMNS;
  const table = db
    .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'item_continuation'")
    .get();
  if (table === null) return "* FROM work_item";
  migratedContinuation.add(db);
  return CONTINUED_ITEM_COLUMNS;
}

export class TransitionRejectedError extends Error {
  readonly reason: "illegal_transition" | "terminal";

  constructor(reason: "illegal_transition" | "terminal") {
    super(reason);
    this.name = "TransitionRejectedError";
    this.reason = reason;
  }
}

export function getWorkItem(db: Database, id: string): WorkItemRecord | null {
  const row = db.query<ItemSql, [string]>(`SELECT ${itemColumns(db)} WHERE id = ?`).get(id);
  return row === null ? null : mapItem(row);
}

export function listWorkItems(db: Database): WorkItemRecord[] {
  return db
    .query<ItemSql, []>(`SELECT ${itemColumns(db)} ORDER BY created_at, id`)
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
      `SELECT ${itemColumns(db)} WHERE state IN (${placeholders}) ORDER BY created_at, id`,
    )
    .all(...states)
    .map(mapItem);
}

export function listInFlightItems(db: Database): WorkItemRecord[] {
  return listWorkItemsByStates(db, IN_FLIGHT_ITEM_STATES);
}

/**
 * What the `work_item_event` row of a transition records beyond the edge itself. A plain
 * transition passes nothing. `restart()` passes kind `restart` with its reason and `ask()` passes
 * kind `ask` with its reason (PAS-627).
 */
export type WorkItemEventRecord =
  | { kind?: "transition"; reason?: string; payloadDigest?: string; actor?: string; now?: number }
  | {
      kind: "restart";
      reason: RestartReason;
      payloadDigest?: string;
      actor?: string;
      now?: number;
    }
  | { kind: "ask"; reason: string; payloadDigest?: string; actor?: string; now?: number };

/**
 * The only writer of `work_item.state`. Throws when `transition` rejects the event. The state
 * change and its `work_item_event` row commit in one immediate transaction, or a savepoint of
 * the caller's, so a rolled-back transition leaves no row.
 */
export function applyWorkItemEvent(
  db: Database,
  id: string,
  event: WorkItemEvent,
  record: WorkItemEventRecord = {},
): WorkItemRecord {
  return immediate(db, () => {
    const current = getWorkItem(db, id);
    if (current === null) {
      throw new Error(`work item ${id} not found`);
    }
    const result = transition(current.state, event);
    if (!result.ok) {
      throw new TransitionRejectedError(result.reason);
    }
    if (event === "take_over") halt(db, current, record.now ?? Date.now());
    // A state whose time is not tracked at all (queued, the merge queue) drops the awake clock's
    // baseline, so the next counted state starts from its own first tick. Otherwise hours in the
    // merge queue would count as agent time once a review sends the item back to the agent.
    const untracked = awakeCategory(result.to, null) === null;
    const updated = db.run(
      `UPDATE work_item SET state = ?, version = version + 1${untracked ? ", last_mono_ms = NULL" : ""}
       WHERE id = ? AND state = ?`,
      [result.to, id, current.state],
    );
    if (updated.changes === 0) {
      throw new Error(`work item ${id} changed before ${event}`);
    }
    if (current.state !== result.to) wakeMergesBehind(db, record.now ?? Date.now());
    if (result.to === "cancelled")
      orm(db)
        .delete(itemReconciliationRequest)
        .where(eq(itemReconciliationRequest.itemId, id))
        .run();
    const next = getWorkItem(db, id);
    if (next === null) throw new Error(`work item ${id} not found`);
    db.run(
      `INSERT INTO work_item_event
         (item_id, version, at, from_state, to_state, event, kind, reason, payload_digest, actor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        next.version,
        record.now ?? Date.now(),
        current.state,
        next.state,
        event,
        record.kind ?? "transition",
        record.reason ?? null,
        record.payloadDigest ?? null,
        record.actor ?? null,
      ],
    );
    journal(
      `transition ${next.linearIdentifier} ${current.state} --${event}--> ${next.state} v${next.version}`,
    );
    return next;
  });
}

/** One committed transition of a work item, from `work_item_event`. */
export type WorkItemEventRow = {
  id: number;
  itemId: string;
  version: number;
  at: number;
  fromState: WorkItemState;
  toState: WorkItemState;
  event: RecordedWorkItemEvent;
  kind: WorkItemEventKind;
  reason: string | null;
  payloadDigest: string | null;
  actor: string | null;
};

/** When each item last changed state, in ms, from `work_item_event`. Items without rows are absent. */
export function listLastWorkItemEventTimes(db: Database): Map<string, number> {
  return new Map(
    db
      .query<{ item_id: string; at: number }, []>(
        "SELECT item_id, MAX(at) AS at FROM work_item_event GROUP BY item_id",
      )
      .all()
      .map((row) => [row.item_id, row.at]),
  );
}

/** An item's history, oldest first. `limit` keeps the newest rows. */
export function listWorkItemEventRows(
  db: Database,
  itemId: string,
  limit = 200,
): WorkItemEventRow[] {
  return db
    .query<
      {
        id: number;
        item_id: string;
        version: number;
        at: number;
        from_state: WorkItemState;
        to_state: WorkItemState;
        event: RecordedWorkItemEvent;
        kind: WorkItemEventKind;
        reason: string | null;
        payload_digest: string | null;
        actor: string | null;
      },
      [string, number]
    >(
      `SELECT * FROM (SELECT * FROM work_item_event WHERE item_id = ? ORDER BY id DESC LIMIT ?)
       ORDER BY id`,
    )
    .all(itemId, limit)
    .map((row) => ({
      id: row.id,
      itemId: row.item_id,
      version: row.version,
      at: row.at,
      fromState: row.from_state,
      toState: row.to_state,
      event: row.event,
      kind: row.kind,
      reason: row.reason,
      payloadDigest: row.payload_digest,
      actor: row.actor,
    }));
}

export function configureWorkItem(
  db: Database,
  id: string,
  patch: { sessionKey?: string; maxAwakeMs?: number; limits?: Partial<StageLimits> },
): void {
  if (patch.sessionKey !== undefined) {
    db.run("UPDATE work_item SET session_key = ? WHERE id = ?", [patch.sessionKey, id]);
  }
  const limits = { implementation: patch.maxAwakeMs, ...patch.limits };
  for (const stage of ["implementation", "fixes", "closeout"] as const) {
    const value = limits[stage];
    if (value !== undefined)
      db.run(`UPDATE work_item SET ${LIMIT_COLUMN[stage]} = ? WHERE id = ?`, [value, id]);
  }
}

const LIMIT_COLUMN: Record<TimeStage, string> = {
  implementation: "max_awake_ms",
  fixes: "max_fix_ms",
  closeout: "max_closeout_ms",
};
const STAGE_COLUMN: Record<TimeStage, string> = {
  implementation: "implement_ms",
  fixes: "fix_ms",
  closeout: "closeout_ms",
};

export function agentTurnStage(db: Database, id: string): "implementation" | "fixes" {
  const row = db
    .query<{ reason: string | null }, [string]>(
      "SELECT reason FROM work_item_event WHERE item_id = ? AND kind = 'restart' ORDER BY id DESC LIMIT 1",
    )
    .get(id);
  return agentStage(row?.reason ?? null);
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

export function syncClock(db: Database, id: string, mono: number): void {
  db.run("UPDATE work_item SET last_mono_ms = ? WHERE id = ?", [mono, id]);
}

export type CapOutcome = {
  /** The task failed on its cap. */
  capped: boolean;
  /** The cap asked in Linear instead of failing. */
  asked?: boolean;
  /** The agent's run ended at the time limit: the caller must stop the live agent. */
  stopAgent?: boolean;
  item: WorkItemRecord;
};

const BREAKDOWN_COLUMN: Record<AwakeCategory, string> = {
  agent: "agent_ms",
  closeout: "closeout_ms",
  waiting: "waiting_ms",
  recheck: "recheck_ms",
};

export function accrueAwake(
  db: Database,
  id: string,
  mono: number,
  now = Date.now(),
  /** An in-memory baseline lets the supervisor skip writes while an item is parked. */
  sinceMono?: number,
  /** Whether a job worked on the item over the interval. Defaults to whether one does now. */
  liveJob?: boolean,
  /**
   * Classifies this interval as a wait even when the job was just claimed. A slot-wait claim
   * settles the parked interval before the attempt runs.
   */
  forcedHold?: "slot" | "ci",
): CapOutcome {
  return immediate(db, () => {
    const current = getWorkItem(db, id);
    if (current === null) throw new Error(`work item ${id} not found`);
    const baseline = sinceMono ?? current.lastMonoMs;
    const delta = baseline === null ? 0 : Math.max(0, mono - baseline);
    const counted = awakeCategory(current.state, current.checkpoint, current.acceptedHead);
    // Only an execution job doing agent or Closeout work spends the budget. Idle running,
    // recovering and verifying items are waiting. Job claims
    // and ends settle the interval before them (accrueAtJobBoundary), so the job status
    // now holds for the whole interval since the last accrual.
    const activity = awakeJobActivity(db, id, now);
    const live = liveJob ?? activity.live;
    const idle = (counted === "agent" || counted === "closeout") && !live;
    // A parked slot wait, or Closeout blocked on CI, is waiting. The caller settles the
    // interval before the wait, so this delta is only the wait itself (PAS-898).
    const hold = forcedHold !== undefined || activity.waiting || activity.usage;
    const category: AwakeCategory | null =
      (idle || hold) && (counted === "agent" || counted === "closeout") ? "waiting" : counted;
    const awake = category === "agent" || category === "closeout";
    const awakeMs = current.awakeMs + (awake ? delta : 0);
    const stage: TimeStage | null =
      category === "agent" ? agentTurnStage(db, id) : category === "closeout" ? "closeout" : null;
    if (delta > 0 || (current.lastMonoMs === null && sinceMono === undefined)) {
      const columns =
        category === null
          ? []
          : category === "agent"
            ? [BREAKDOWN_COLUMN.agent, STAGE_COLUMN[stage!]]
            : [BREAKDOWN_COLUMN[category]];
      db.run(
        `UPDATE work_item SET awake_ms = ?, last_mono_ms = ?${columns
          .map((column) => `, ${column} = ${column} + ?`)
          .join("")} WHERE id = ?`,
        [awakeMs, mono, ...columns.map(() => delta), id],
      );
    }
    if (!awake) {
      const updated = getWorkItem(db, id);
      if (updated === null) throw new Error(`work item ${id} not found`);
      return { capped: false, item: updated };
    }
    return enforceCaps(db, id, stage!, now);
  });
}

/**
 * Settle active time at every execution claim and end. The interval before a claim
 * stays waiting; the final stretch before an execution job ends still counts as work.
 */
export function accrueAtJobBoundary(
  db: Database,
  job: { id: number; payload: unknown },
  boundary: "claimed" | "ending",
  mono: number,
  now: number,
): void {
  const itemId = (job.payload as { itemId?: unknown } | null)?.itemId;
  if (typeof itemId !== "string") return;
  immediate(db, () => {
    const item = getWorkItem(db, itemId);
    if (item === null) return;
    // The claim ends a parked slot wait. Settle that interval as waiting before the attempt.
    if (boundary === "claimed" && runnerCapacityWait(job.payload) && isAwakeItemState(item.state)) {
      accrueAwake(db, itemId, mono, now, undefined, false, "slot");
      return;
    }
    if (!isAwakeItemState(item.state) && boundary !== "claimed") return;
    const liveJob = awakeJobActivity(db, itemId, now, boundary === "claimed" ? job.id : -1).live;
    accrueAwake(db, itemId, mono, now, undefined, liveJob);
  });
}

/** Wait bookkeeping belongs to one claim. A stale finally may clear only its own mark. */
export function markJobAwakeWait(
  db: Database,
  job: Job,
  waiting: boolean,
  mono: number,
  now: number,
  reason: "ci" | "runner" | "backoff" = "ci",
): void {
  const itemId = (job.payload as { itemId?: string }).itemId;
  if (!itemId) return;
  immediate(db, () => {
    accrueAwake(db, itemId, mono, now);
    if (waiting) {
      db.run(
        `UPDATE job SET payload = json_set(payload, '$.awakeWait',
           json_object('kind', ?1, 'worker', locked_by, 'attempt', attempts))
         WHERE id=?2 AND status='running' AND locked_by=?3 AND attempts=?4 AND locked_until>?5`,
        [reason, job.id, job.lockedBy, job.attempts, now],
      );
    } else {
      db.run(
        `UPDATE job SET payload = json_remove(payload, '$.awakeWait')
         WHERE id=? AND json_extract(payload, '$.awakeWait.worker')=?
           AND json_extract(payload, '$.awakeWait.attempt')=?`,
        [job.id, job.lockedBy, job.attempts],
      );
    }
  });
}

export type AgentWaitRun = { itemId: string; runId: string; generation: number };

export function startAgentWait(db: Database, run: AgentWaitRun, mono: number, now: number): void {
  immediate(db, () => {
    if (getWorkItem(db, run.itemId) === null) return;
    const item = accrueAwake(db, run.itemId, mono, now).item;
    db.run(
      `INSERT INTO agent_wait(run_id,generation,started_at,waiting_ms) VALUES(?,?,?,?)
       ON CONFLICT(run_id) DO UPDATE SET generation=excluded.generation,
         started_at=excluded.started_at,waiting_ms=excluded.waiting_ms`,
      [run.runId, run.generation, now, item.waitingMs],
    );
  });
}

export function endAgentWait(
  db: Database,
  run: AgentWaitRun,
  mono: number,
  now: number,
  waitedMs?: number,
): void {
  immediate(db, () => {
    const open = db
      .query<{ waitingMs: number }, [string, number]>(
        "SELECT waiting_ms AS waitingMs FROM agent_wait WHERE run_id=? AND generation=?",
      )
      .get(run.runId, run.generation);
    if (open === null || getWorkItem(db, run.itemId) === null) return;
    const item = accrueAwake(db, run.itemId, mono, now).item;
    db.run("DELETE FROM agent_wait WHERE run_id=?", [run.runId]);
    if (waitedMs === undefined) return;
    const counted = Math.max(0, item.waitingMs - open.waitingMs);
    const stage = agentTurnStage(db, run.itemId);
    const moved = Math.min(
      Math.max(0, waitedMs - counted),
      item.agentMs,
      stage === "implementation" ? item.implementMs : item.fixMs,
    );
    if (moved > 0)
      db.run(
        `UPDATE work_item SET awake_ms = awake_ms - ?1, agent_ms = agent_ms - ?1,
           ${STAGE_COLUMN[stage]} = ${STAGE_COLUMN[stage]} - ?1,
           waiting_ms = waiting_ms + ?1 WHERE id = ?2`,
        [moved, run.itemId],
      );
  });
}

/** Read ownership and wait flags in one scan for each accrual. Pending CI marks are never live. */
function awakeJobActivity(db: Database, itemId: string, now: number, exceptJobId = -1) {
  const row = db
    .query<
      { live: number; waiting: number; usage: number; agent: number },
      [number, string, string, string, string, string, number, number]
    >(
      `SELECT (COALESCE(MAX(status='running' AND locked_until>?1), 0) OR EXISTS(
         SELECT 1 FROM runner_work w JOIN work_item i ON i.current_run_id=w.run_id
         WHERE i.id=?2 AND w.ended_at IS NULL AND w.lease_until>?8)) AS live,
       COALESCE(MAX(status='running' AND locked_until>?1
         AND json_extract(payload, '$.awakeWait.kind') IN ('ci', 'runner', 'backoff')
         AND json_extract(payload, '$.awakeWait.worker')=locked_by
         AND json_extract(payload, '$.awakeWait.attempt')=attempts), 0) AS waiting,
       EXISTS(SELECT 1 FROM usage_pause p JOIN work_item i ON i.current_run_id=p.run_id
         WHERE i.id=?2) AS usage,
       EXISTS(SELECT 1 FROM agent_wait a JOIN work_item i ON i.current_run_id=a.run_id
         JOIN runner_work w ON w.run_id=a.run_id AND w.generation=a.generation
         WHERE i.id=?2 AND w.ended_at IS NULL AND w.lease_until>?8) AS agent
     FROM job WHERE json_extract(payload, '$.itemId')=?2
       AND status IN ('pending', 'running') AND id<>?7
       AND (queue IN (?3, ?4, ?5, ?6) OR queue LIKE (?6 || '.%'))`,
    )
    .get(
      now,
      itemId,
      JOB_KIND.start,
      JOB_KIND.resume,
      JOB_KIND.reverify,
      JOB_KIND.merge,
      exceptJobId,
      runnerLeaseCutoff(now),
    )!;
  return {
    live: row.live === 1,
    waiting: row.waiting === 1 || row.agent === 1,
    usage: row.usage === 1,
  };
}

/**
 * Asks in Linear when an item reaches its time cap. Work Closeout already accepted keeps
 * publishing and merging, and only a resumed agent stops to ask. Before acceptance, a
 * running agent or Closeout run stops to ask. The cap fails an item only when it cannot ask.
 */
function enforceCaps(db: Database, id: string, stage: TimeStage, now: number): CapOutcome {
  const updated = getWorkItem(db, id);
  if (updated === null) throw new Error(`work item ${id} not found`);
  if (!stageReached(updated, stage)) return { capped: false, item: updated };
  const accepted = updated.acceptedHead !== null;
  if (
    !accepted &&
    (updated.sessionKey === null || (updated.state !== "running" && updated.state !== "verifying"))
  ) {
    failForCap(db, updated, stage, now);
    return { capped: true, item: refetch() };
  }
  if (accepted && updated.state !== "running") return { capped: false, item: updated };
  if (
    db
      .query(
        "SELECT 1 FROM job WHERE queue='item.ask' AND status IN ('pending','running') AND json_extract(payload,'$.itemId')=?",
      )
      .get(id)
  )
    return { capped: false, item: updated };
  if (askTimeLimit(db, updated, stage, now))
    return { capped: false, asked: true, stopAgent: true, item: refetch() };
  pauseAtTimeLimit(db, updated, stage, now);
  return { capped: false, stopAgent: true, item: refetch() };

  function refetch(): WorkItemRecord {
    const item = getWorkItem(db, id);
    if (item === null) throw new Error(`work item ${id} not found`);
    return item;
  }
}

export function awakeBreakdown(item: WorkItemRecord): AwakeBreakdown {
  return {
    agentMs: item.agentMs,
    implementMs: item.implementMs,
    fixMs: item.fixMs,
    closeoutMs: item.closeoutMs,
    waitingMs: item.waitingMs,
    recheckMs: item.recheckMs,
  };
}

/** Closeout accepted `head`. The time cap no longer fails this task. */
export function markCloseoutAccepted(db: Database, id: string, head: string): void {
  db.run("UPDATE work_item SET accepted_head = ? WHERE id = ?", [head, id]);
}

function extendAwakeCap(
  db: Database,
  id: string,
  stage: TimeStage,
  extraMs = TIME_LIMIT_EXTENSION_MS,
): void {
  const limit = LIMIT_COLUMN[stage];
  db.run(`UPDATE work_item SET ${limit} = MAX(${limit}, ${STAGE_COLUMN[stage]}) + ? WHERE id = ?`, [
    extraMs,
    id,
  ]);
}

/** Zeroes the awake clock and its breakdown when a stopped task is started again. */
export function resetAwakeTime(db: Database, id: string): void {
  db.run(
    `UPDATE work_item
     SET awake_ms = 0, agent_ms = 0, implement_ms = 0, fix_ms = 0, closeout_ms = 0,
         waiting_ms = 0, recheck_ms = 0, last_mono_ms = NULL
     WHERE id = ?`,
    [id],
  );
}

export function resetStageTime(db: Database, id: string, stage: TimeStage): void {
  db.run(`UPDATE work_item SET ${STAGE_COLUMN[stage]} = 0 WHERE id = ?`, [id]);
}

/**
 * Cancels the agent's pending start and resume jobs at the time limit, and the Closeout
 * run of work not yet accepted. Merge jobs stay: Paws keeps publishing and merging
 * accepted work.
 */
function cancelAgentJobs(db: Database, itemId: string, now: number, closeout = false): void {
  const queues: string[] = [JOB_KIND.start, JOB_KIND.resume];
  if (closeout) queues.push(JOB_KIND.reverify);
  db.run(
    `UPDATE job
     SET status = 'cancelled', last_error = 'time_limit', locked_by = NULL,
         locked_until = NULL, finished_at = ?
     WHERE status IN ('pending', 'running') AND queue IN (${queues.map(() => "?").join(", ")})
       AND json_extract(payload, '$.itemId') = ?`,
    [now, ...queues, itemId],
  );
}

/** A resume the time limit cancelled before the agent started it, with its handoff. */
export type HeldHandoff = { jobId: number; handoff: string };

/**
 * Handoffs of resume jobs the time limit cancelled that no later restart carried yet, oldest
 * first. A review or comment restart that the cap cut off waits here for a Continue answer.
 */
export function heldHandoffs(db: Database, itemId: string): HeldHandoff[] {
  return db
    .query<{ id: number; handoff: string | null }, [string, string]>(
      `SELECT id, json_extract(payload, '$.handoff') AS handoff FROM job
       WHERE queue = ? AND status = 'cancelled' AND last_error = 'time_limit'
         AND json_extract(payload, '$.itemId') = ?
       ORDER BY id`,
    )
    .all(JOB_KIND.resume, itemId)
    .filter((row) => typeof row.handoff === "string" && row.handoff.trim() !== "")
    .map((row) => ({ jobId: row.id, handoff: row.handoff! }));
}

/** Marks held handoffs as carried by a later restart, so none reaches the agent twice. */
export function markHandoffsCarried(db: Database, held: readonly HeldHandoff[]): void {
  for (const entry of held)
    db.run("UPDATE job SET last_error = 'time_limit_carried' WHERE id = ?", [entry.jobId]);
}

/**
 * Without a Linear session to ask in, accepted work pauses at the time limit
 * instead of failing. The cap already allows another hour, so resuming it from
 * the run page keeps going.
 */
function pauseAtTimeLimit(db: Database, item: WorkItemRecord, stage: TimeStage, now: number): void {
  applyWorkItemEvent(db, item.id, "pause");
  cancelAgentJobs(db, item.id, now);
  if (item.currentRunId !== null) {
    const run = getRun(db, item.currentRunId);
    if (run?.status === "active") markRun(db, run.id, "ended", now);
  }
  extendAwakeCap(db, item.id, stage);
  journal(`item ${item.linearIdentifier} reached its time cap after acceptance; paused`);
  enqueueOutboxOnce(db, {
    target: OUTBOX_ACTIVITY.target,
    op: OUTBOX_ACTIVITY.op,
    orderingKey: item.id,
    idempotencyKey: `time-limit-pause:${item.id}:${item.version}`,
    payload: { sessionId: item.id, kind: "thought", body: timeLimitPausedNote(item, stage) },
    now,
  });
}

function timeLimitPausedNote(item: WorkItemRecord, stage: TimeStage): string {
  const limits = stageLimits(item);
  return `Paused at the time limit: ${capActivityText(stage, limits)} Closeout already accepted this task's work, so Paws did not fail it. ${formatAwakeBreakdown(awakeBreakdown(item), limits)} Resume it from the run page to give the agent another hour.`;
}

/**
 * Stops the agent's or Closeout's run and asks "continue or stop?" in Linear, offering
 * Merge when Closeout accepted a head. Returns false when the task has no Linear session.
 */
function askTimeLimit(db: Database, item: WorkItemRecord, stage: TimeStage, now: number): boolean {
  const sessionId = item.sessionKey;
  if (sessionId === null) return false;
  const accepted = item.acceptedHead !== null;
  const verifying = item.state === "verifying";
  cancelAgentJobs(db, item.id, now, !accepted);
  const held = heldHandoffs(db, item.id).length > 0;
  if (accepted && item.currentRunId) releaseRunCapacity(db, item.currentRunId, now);
  enqueueJobOnce(db, {
    queue: "item.ask",
    jobKey: `time-limit:${item.id}:${item.version}`,
    payload: {
      itemId: item.id,
      kind: "time-limit",
      reason: verifying ? TIME_LIMIT_VERIFYING_REASON : "time_limit",
      body: accepted
        ? timeLimitQuestion(stage, stageLimits(item), awakeBreakdown(item), held)
        : unacceptedTimeLimitQuestion(
            stage,
            stageLimits(item),
            awakeBreakdown(item),
            verifying,
            held,
          ),
      options: accepted ? [...TIME_LIMIT_OPTIONS] : [...UNACCEPTED_TIME_LIMIT_OPTIONS],
    },
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
  options: { stoppedByAnswer?: boolean } = {},
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
      options.stoppedByAnswer === true,
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
    const fact = getConfirmedRemoteMerge(db, current.id)!;
    const sessionId = current.sessionKey ?? current.id;
    const generation = getLinearSessionGeneration(db, sessionId);
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "activity",
      orderingKey: sessionId,
      delivery: mergeStopRequested(db, current.id) ? "stop" : "ordered",
      generation,
      idempotencyKey: `merged:${current.id}:${generation}`,
      payload: {
        sessionId,
        itemId: current.id,
        kind: "response",
        body: withOpenFindings(
          db,
          current.id,
          `Merged #${fact.pullNumber} into main at ${fact.mergeSha ?? "unknown commit"}. ${current.linearIdentifier} is Done.`,
        ),
      },
      now: input.now,
    });
    const remaining = getPullRequestDraft(db, current.id)?.remaining;
    if (remaining?.length)
      enqueueOutboxOnce(db, {
        target: "linear",
        op: "linear.remaining_issues",
        orderingKey: current.linearIssueId,
        idempotencyKey: `remaining:${current.id}`,
        payload: {
          itemId: current.id,
          issueId: current.linearIssueId,
          identifier: current.linearIdentifier,
          repository: `${fact.repositoryOwner}/${fact.repositoryName}`,
          pullUrl:
            fact.pullUrl ??
            `https://github.com/${fact.repositoryOwner}/${fact.repositoryName}/pull/${fact.pullNumber}`,
          parts: remaining,
        },
        now: input.now,
      });
    input.announce?.(current);
    const merged = applyWorkItemEvent(db, current.id, "merge_accepted", { now: input.now });
    endMergeCall(db, current.id);
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
    lastError?: string;
    capacityWait?: RunnerCapacityWaitState;
    closeoutFault?: CloseoutFaults & { jobId: number; reviewer?: string };
  },
): void {
  immediate(db, () => {
    const before = getWorkItem(db, item.id) ?? item;
    const reverify = before.state === "verifying" && hasVerificationCandidate(before.checkpoint);
    if (!reverify && (item.state === "running" || item.state === "verifying"))
      applyWorkItemEvent(db, item.id, "deferred");
    const current = getWorkItem(db, item.id) ?? item;
    journal(
      `item ${item.linearIdentifier} deferred: ${reverify ? "re-verify" : "retry"} ${input.retry} in ${input.delayMs} ms`,
    );
    if (current.currentRunId !== null) {
      const run = getRun(db, current.currentRunId);
      if (run && (run.status === "active" || run.status === "provisioning"))
        markRun(db, run.id, "lost", input.now);
    }
    const capacityWait = input.capacityWait ? { capacityWait: input.capacityWait } : {};
    const lastError = input.lastError === undefined ? {} : { lastError: input.lastError };
    const fault = input.closeoutFault;
    if (reverify && fault)
      enqueueJobOnce(db, {
        queue: JOB_KIND.reverify,
        jobKey: `reverify:closeout-fault:${item.id}:${fault.jobId}`,
        runAt: input.now + input.delayMs,
        payload: {
          itemId: item.id,
          runId: current.currentRunId,
          reason: "closeout_fault",
          recheckHead: true,
          failClosed: true,
          closeoutFaults: { head: fault.head, reasons: fault.reasons },
          ...(fault.reviewer === undefined ? {} : { reviewerFault: fault.reviewer }),
        },
        now: input.now,
      });
    else if (reverify)
      enqueueJobOnce(db, {
        queue: JOB_KIND.reverify,
        jobKey: `reverify:retry:${item.id}:${current.version}:${input.retry}`,
        runAt: input.now + input.delayMs,
        maxAttempts: Math.max(1, MAX_TRANSIENT_RETRIES - input.retry + 1),
        payload: {
          itemId: item.id,
          runId: current.currentRunId,
          reason: "transient_failure",
          retry: input.retry,
          recheckHead: true,
          failClosed: true,
          ...capacityWait,
          ...lastError,
        },
        now: input.now,
      });
    else
      enqueueJobOnce(db, {
        queue: JOB_KIND.resume,
        jobKey: `resume:${item.id}:${current.version}`,
        runAt: input.now + input.delayMs,
        payload: {
          itemId: item.id,
          runId: current.currentRunId,
          reason: "transient_failure",
          retry: input.retry,
          ...pendingRestartHandoff(db, item.id),
          ...(input.handoff === null ? {} : { handoff: input.handoff }),
          ...capacityWait,
          ...lastError,
        },
        now: input.now,
      });
    if (input.message !== null)
      enqueueOutboxOnce(db, {
        target: OUTBOX_ACTIVITY.target,
        op: OUTBOX_ACTIVITY.op,
        orderingKey: item.sessionKey ?? item.id,
        idempotencyKey: fault
          ? fault.reviewer === undefined
            ? `closeout-fault:${item.id}:${fault.jobId}`
            : `${REVIEWER_ALERT}${fault.reviewer}:${item.id}:${fault.jobId}`
          : `retry:${item.id}:${current.version}`,
        payload: { sessionId: item.sessionKey ?? item.id, kind: "thought", body: input.message },
        now: input.now,
      });
  });
}

export type CloseoutFaults = { head: string; reasons: readonly string[] };

const REVIEWER_ALERT = "reviewer-fault:";

export function reviewerFaultHolds(db: Database, reviewer: string): WorkItemRecord[] {
  return db
    .query<{ itemId: string }, [string, string]>(
      `SELECT DISTINCT json_extract(payload,'$.itemId') AS itemId FROM job
       WHERE queue=? AND status='pending' AND json_extract(payload,'$.reviewerFault')=?`,
    )
    .all(JOB_KIND.reverify, reviewer)
    .flatMap((row) => getWorkItem(db, row.itemId) ?? []);
}

export function reviewerAlertedSince(db: Database, reviewer: string, since: number): boolean {
  return (
    db
      .query("SELECT 1 FROM outbox WHERE idempotency_key LIKE ? AND created_at>=?")
      .get(`${REVIEWER_ALERT}${reviewer}:%`, since) !== null
  );
}

export function releaseReviewerFaultHolds(db: Database, itemId: string, now: number): number {
  return db.run(
    `UPDATE job SET run_at=?, payload=json_remove(payload,'$.closeoutFaults','$.reviewerFault')
     WHERE queue=? AND status='pending' AND json_extract(payload,'$.itemId')=?
       AND json_extract(payload,'$.reviewerFault') IS NOT NULL`,
    [now, JOB_KIND.reverify, itemId],
  ).changes;
}

export type RunnerCapacityWaitState = {
  since: number;
  attempt: number;
  runnerIds: readonly string[];
  online?: readonly string[];
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
        ...(Array.isArray(wait.online) ? { online: wait.online } : {}),
        ...(typeof wait.holdMs === "number" ? { holdMs: wait.holdMs } : {}),
      }
    : null;
}

function failForCap(db: Database, item: WorkItemRecord, stage: TimeStage, now: number): void {
  commitFailure(
    db,
    item,
    "cap:time",
    capActivityText(stage, stageLimits(item), awakeBreakdown(item)),
    now,
    (version) => `cap:${item.id}:${version}:time`,
  );
}

function commitFailure(
  db: Database,
  item: WorkItemRecord,
  reason: string,
  text: string,
  now: number,
  idempotencyKey: (version: number) => string,
  stoppedByAnswer = false,
): void {
  const version = moveToFailed(db, item, stoppedByAnswer);
  journal(`item ${item.linearIdentifier} failed: ${reason}`);
  db.run("UPDATE work_item SET cancel_requested = 1 WHERE id = ?", [item.id]);
  if (item.currentRunId !== null) markRun(db, item.currentRunId, "lost", now);
  cancelOpenJobs(db, { itemId: item.id, reason, now });
  const sessionId = item.sessionKey ?? item.id;
  const generation = getLinearSessionGeneration(db, sessionId);
  const afterPr =
    db
      .query(`SELECT 1 FROM outbox WHERE target='linear' AND ordering_key=?
    AND delivery_generation=? AND idempotency_key LIKE 'pull-request-ready:%' AND status!='dropped' LIMIT 1`)
      .get(sessionId, generation) !== null;
  enqueueOutboxOnce(db, {
    target: OUTBOX_ACTIVITY.target,
    op: OUTBOX_ACTIVITY.op,
    orderingKey: sessionId,
    ...(afterPr ? { delivery: "ordered" as const, generation } : {}),
    idempotencyKey: afterPr ? `closed:${item.id}:${generation}` : idempotencyKey(version),
    payload: {
      sessionId,
      kind: afterPr ? "response" : "error",
      body: afterPr ? withOpenFindings(db, item.id, `Closed: ${text}`) : text,
    },
    now,
  });
}

function moveToFailed(db: Database, item: WorkItemRecord, stopped: boolean): number {
  if (item.state === "failed") return item.version;
  const event =
    stopped && item.state === "awaiting_input" ? "answer_stopped" : failureEvent(item.state);
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
    case "merge_queue":
      return "work_failed";
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
    continuesItemId: row.continues_item_id ?? null,
    continuesBranch: row.continues_branch ?? null,
    position: row.position,
    version: row.version,
    checkpoint: parseCheckpoint(row.checkpoint),
    recoveryAttempts: row.recovery_attempts,
    resumedAt: row.resumed_at,
    awakeMs: row.awake_ms,
    lastMonoMs: row.last_mono_ms,
    maxAwakeMs: row.max_awake_ms,
    maxFixMs: row.max_fix_ms ?? 0,
    maxCloseoutMs: row.max_closeout_ms ?? 0,
    linearProjectId: row.linear_project_id ?? null,
    acceptedHead: row.accepted_head ?? null,
    agentMs: row.agent_ms ?? 0,
    implementMs: row.implement_ms ?? 0,
    fixMs: row.fix_ms ?? 0,
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
  return readCheckpoint(value);
}

export function itemDelegationId(db: Database, itemId: string): string | null {
  return (
    orm(db)
      .select({ id: workItem.delegationId })
      .from(workItem)
      .where(eq(workItem.id, itemId))
      .get()?.id ?? null
  );
}

export function itemLinearIdentifier(db: Database, itemId: string): string | null {
  return (
    orm(db)
      .select({ name: workItem.linearIdentifier })
      .from(workItem)
      .where(eq(workItem.id, itemId))
      .get()?.name ?? null
  );
}

export function lastItemEvent(
  db: Database,
  itemId: string,
): { kind: string; reason: string | null } | null {
  return (
    orm(db)
      .select({ kind: workItemEvent.kind, reason: workItemEvent.reason })
      .from(workItemEvent)
      .where(eq(workItemEvent.itemId, itemId))
      .orderBy(desc(workItemEvent.id))
      .limit(1)
      .get() ?? null
  );
}
