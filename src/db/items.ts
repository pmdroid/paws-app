import type { Database } from "bun:sqlite";
import { halt } from "./halt";
import { readCheckpoint } from "./checkpoint";
import {
  awakeCategory,
  capActivityText,
  capReason,
  formatAwakeBreakdown,
  timeLimitQuestion,
  TIME_LIMIT_EXTENSION_MS,
  TIME_LIMIT_OPTIONS,
  type AwakeBreakdown,
  type AwakeCategory,
  IN_FLIGHT_ITEM_STATES,
  isAwakeItemState,
  isTerminalWorkItemState,
  JOB_KIND,
  OUTBOX_ACTIVITY,
  transition,
  type Checkpoint,
  type RestartReason,
  type WorkItemEvent,
  type WorkItemEventKind,
  type WorkItemState,
  type WorkBrief,
} from "../core";
import { cancelOpenJobs, enqueueJobOnce, hasLiveJob, type Job } from "./jobs";
import { journal } from "./journal";
import { enqueueOutboxOnce } from "./outbox";
import { getLinearSessionGeneration } from "./linear-sessions";
import { withOpenFindings } from "./open-findings";
import { getRun, markRun, releaseRunCapacity } from "./runs";
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
  continues_item_id?: string | null;
  continues_branch?: string | null;
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
  event: WorkItemEvent;
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
        event: WorkItemEvent;
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
    // Closeout time is time a job spends verifying. An item left in `verifying` with no
    // job working on it is idle and does not count toward the cap (PAS-771). Job claims
    // and ends settle the interval before them (accrueAtJobBoundary), so the job status
    // now holds for the whole interval since the last accrual.
    const activity = awakeJobActivity(db, id, now);
    const live = liveJob ?? activity.live;
    const idle = counted === "closeout" && !live;
    // A parked slot wait, or Closeout blocked on CI, is waiting. The caller settles the
    // interval before the wait, so this delta is only the wait itself (PAS-898).
    const hold = forcedHold ?? (activity.ci ? "ci" : activity.slot && !live ? "slot" : null);
    let category: AwakeCategory | null = idle ? null : counted;
    if (hold === "slot" && (counted === "agent" || counted === "closeout")) category = "waiting";
    if (hold === "ci" && counted === "closeout") category = "waiting";
    const awake = category === "agent" || category === "closeout";
    const awakeMs = current.awakeMs + (awake ? delta : 0);
    if (delta > 0 || (current.lastMonoMs === null && sinceMono === undefined)) {
      const breakdown =
        category === null
          ? ""
          : `, ${BREAKDOWN_COLUMN[category]} = ${BREAKDOWN_COLUMN[category]} + ?`;
      db.run(
        `UPDATE work_item SET awake_ms = ?, last_mono_ms = ?${breakdown} WHERE id = ?`,
        category === null ? [awakeMs, mono, id] : [awakeMs, mono, delta, id],
      );
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
 * Settles a verifying item's awake time when a job claims it or ends, so the interval
 * before the boundary counts by whether a job worked on the item then (PAS-771): idle time
 * before a claim stays idle, and the last stretch of a job still counts as Closeout.
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
    if (item.state !== "verifying") return;
    const liveJob = boundary === "ending" || hasLiveJob(db, itemId, now, job.id);
    accrueAwake(db, itemId, mono, now, undefined, liveJob);
  });
}

/** CI bookkeeping belongs to one claim. A stale finally may clear only its own mark. */
export function markCloseoutCiWait(
  db: Database,
  job: Job,
  waiting: boolean,
  mono: number,
  now: number,
): void {
  const itemId = (job.payload as { itemId?: string }).itemId;
  if (!itemId) return;
  immediate(db, () => {
    accrueAwake(db, itemId, mono, now);
    if (waiting) {
      db.run(
        `UPDATE job SET payload = json_set(payload, '$.awakeWait',
           json_object('kind', 'ci', 'worker', locked_by, 'attempt', attempts))
         WHERE id=? AND status='running' AND locked_by=? AND attempts=? AND locked_until>?`,
        [job.id, job.lockedBy, job.attempts, now],
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

/** Read ownership and wait flags in one scan for each accrual. Pending CI marks are never live. */
function awakeJobActivity(db: Database, itemId: string, now: number) {
  const row = db
    .query<{ live: number; slot: number; ci: number }, [number, string, string, string, string]>(
      `SELECT
       COALESCE(MAX(status='running' AND locked_until>?1), 0) AS live,
       COALESCE(MAX(status='pending' AND queue IN (?3, ?4, ?5)
         AND json_extract(payload, '$.capacityWait') IS NOT NULL), 0) AS slot,
       COALESCE(MAX(status='running' AND locked_until>?1
         AND json_extract(payload, '$.awakeWait.kind')='ci'
         AND json_extract(payload, '$.awakeWait.worker')=locked_by
         AND json_extract(payload, '$.awakeWait.attempt')=attempts), 0) AS ci
     FROM job WHERE json_extract(payload, '$.itemId')=?2
       AND status IN ('pending', 'running')`,
    )
    .get(now, itemId, JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify)!;
  return { live: row.live === 1, slot: row.slot === 1, ci: row.ci === 1 };
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
    if (
      db
        .query(
          "SELECT 1 FROM job WHERE queue='item.ask' AND status IN ('pending','running') AND json_extract(payload,'$.itemId')=?",
        )
        .get(id)
    )
      return { capped: false, item: updated };
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
  cancelAgentJobs(db, item.id, now);
  const held = heldHandoffs(db, item.id).length > 0;
  if (item.currentRunId) releaseRunCapacity(db, item.currentRunId, now);
  enqueueJobOnce(db, {
    queue: "item.ask",
    jobKey: `time-limit:${item.id}:${item.version}`,
    payload: {
      itemId: item.id,
      kind: "time-limit",
      reason: "time_limit",
      body: timeLimitQuestion(item.maxAwakeMs, awakeBreakdown(item), held),
      options: [...TIME_LIMIT_OPTIONS],
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
    const fact = getConfirmedRemoteMerge(db, current.id)!;
    const sessionId = current.sessionKey ?? current.id;
    const generation = getLinearSessionGeneration(db, sessionId);
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "activity",
      orderingKey: sessionId,
      delivery: "ordered",
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
    continuesItemId: row.continues_item_id ?? null,
    continuesBranch: row.continues_branch ?? null,
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
  return readCheckpoint(value);
}
