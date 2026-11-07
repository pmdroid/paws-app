import { pendingRestartHandoff } from "./restart";
import type { Database } from "bun:sqlite";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  max,
  min,
  ne,
  or,
  sql,
  type AnyColumn,
  type SQL,
} from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
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
import { itemReconciliationRequest } from "./schema";
import type { workItem as pgWorkItem } from "./schema-pg";
import { immediate } from "./tx";
import { runnerLeaseCutoff } from "./runner-lease";

type PgWorkItem = typeof pgWorkItem.$inferSelect;

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

export class TransitionRejectedError extends Error {
  readonly reason: "illegal_transition" | "terminal";

  constructor(reason: "illegal_transition" | "terminal") {
    super(reason);
    this.name = "TransitionRejectedError";
    this.reason = reason;
  }
}

/** Work item columns with the branch an item continues, from `item_continuation`. */
function selectItems(q: Q, columns: object = q.t.workItem) {
  const { workItem, itemContinuation } = q.t;
  return q.orm
    .select({
      item: columns as typeof workItem,
      continuesItemId: itemContinuation.previousItemId,
      continuesBranch: itemContinuation.branch,
    })
    .from(workItem)
    .leftJoin(itemContinuation, eq(itemContinuation.itemId, workItem.id))
    .$dynamic();
}

const completeItemTables = new WeakSet<object>();

/** A database migrated only partway, as migration tests build, has no `item_continuation` yet. */
function* itemQuerySteps(q: Q) {
  if (q.dialect === "postgres" || completeItemTables.has(q.orm)) return selectItems(q);
  const { workItem } = q.t;
  const names = new Set(
    (yield* q.all(
      q.orm.select({ name: sql<string>`name` }).from(sql`pragma_table_info('work_item')`),
    )).map((row) => row.name),
  );
  const continuation = yield* q.one(
    q.orm
      .select({ name: sql<string>`name` })
      .from(sql`sqlite_master`)
      .where(sql`type = 'table' AND name = 'item_continuation'`),
  );
  const columns = Object.fromEntries(
    Object.entries(getTableColumns(workItem)).filter(([, column]) => names.has(column.name)),
  );
  const complete = Object.keys(columns).length === Object.keys(getTableColumns(workItem)).length;
  if (complete && continuation !== undefined) {
    completeItemTables.add(q.orm);
    return selectItems(q);
  }
  if (continuation !== undefined) return selectItems(q, columns);
  return q.orm
    .select({
      item: columns,
      continuesItemId: sql<string | null>`NULL`,
      continuesBranch: sql<string | null>`NULL`,
    })
    .from(workItem)
    .$dynamic() as unknown as ReturnType<typeof selectItems>;
}

export function* getWorkItemSteps(q: Q, id: string) {
  const items = yield* itemQuerySteps(q);
  const row = yield* q.one(items.where(eq(q.t.workItem.id, id)));
  return row === undefined ? null : mapItem(row);
}

export function getWorkItem(db: Database, id: string): WorkItemRecord | null {
  return settled(sqliteDb(db).run((q) => getWorkItemSteps(q, id)));
}

export function* listWorkItemsSteps(q: Q) {
  const { workItem } = q.t;
  const items = yield* itemQuerySteps(q);
  const rows = yield* q.all(items.orderBy(asc(workItem.createdAt), asc(workItem.id)));
  return rows.map(mapItem);
}

export function listWorkItems(db: Database): WorkItemRecord[] {
  return settled(sqliteDb(db).run(listWorkItemsSteps));
}

export function* listWorkItemsByStatesSteps(q: Q, states: readonly WorkItemState[]) {
  if (states.length === 0) return [];
  const { workItem } = q.t;
  const items = yield* itemQuerySteps(q);
  const rows = yield* q.all(
    items
      .where(inArray(workItem.state, [...states]))
      .orderBy(asc(workItem.createdAt), asc(workItem.id)),
  );
  return rows.map(mapItem);
}

export function listWorkItemsByStates(
  db: Database,
  states: readonly WorkItemState[],
): WorkItemRecord[] {
  return settled(sqliteDb(db).run((q) => listWorkItemsByStatesSteps(q, states)));
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
export function* listLastWorkItemEventTimesSteps(q: Q) {
  const { workItemEvent } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ itemId: workItemEvent.itemId, at: max(workItemEvent.at) })
      .from(workItemEvent)
      .groupBy(workItemEvent.itemId),
  );
  return new Map(rows.map((row) => [row.itemId, row.at!]));
}

export function listLastWorkItemEventTimes(db: Database): Map<string, number> {
  return settled(sqliteDb(db).run(listLastWorkItemEventTimesSteps));
}

/** An item's history, oldest first. `limit` keeps the newest rows. */
export function* listWorkItemEventRowsSteps(q: Q, itemId: string, limit = 200) {
  const { workItemEvent } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(workItemEvent)
      .where(eq(workItemEvent.itemId, itemId))
      .orderBy(desc(workItemEvent.id))
      .limit(limit),
  );
  return rows.reverse() as WorkItemEventRow[];
}

export function listWorkItemEventRows(
  db: Database,
  itemId: string,
  limit = 200,
): WorkItemEventRow[] {
  return settled(sqliteDb(db).run((q) => listWorkItemEventRowsSteps(q, itemId, limit)));
}

export function* configureWorkItemSteps(
  q: Q,
  id: string,
  patch: { sessionKey?: string; maxAwakeMs?: number; limits?: Partial<StageLimits> },
) {
  const { workItem } = q.t;
  if (patch.sessionKey !== undefined)
    yield* q.exec(
      q.orm.update(workItem).set({ sessionKey: patch.sessionKey }).where(eq(workItem.id, id)),
    );
  const limits = { implementation: patch.maxAwakeMs, ...patch.limits };
  for (const stage of ["implementation", "fixes", "closeout"] as const) {
    const value = limits[stage];
    if (value !== undefined)
      yield* q.exec(
        q.orm
          .update(workItem)
          .set({ [LIMIT_COLUMN[stage]]: value })
          .where(eq(workItem.id, id)),
      );
  }
}

export function configureWorkItem(
  db: Database,
  id: string,
  patch: { sessionKey?: string; maxAwakeMs?: number; limits?: Partial<StageLimits> },
): void {
  settled(sqliteDb(db).run((q) => configureWorkItemSteps(q, id, patch)));
}

type ItemColumn = keyof PgWorkItem;

const LIMIT_COLUMN = {
  implementation: "maxAwakeMs",
  fixes: "maxFixMs",
  closeout: "maxCloseoutMs",
} as const satisfies Record<TimeStage, ItemColumn>;
const STAGE_COLUMN = {
  implementation: "implementMs",
  fixes: "fixMs",
  closeout: "closeoutMs",
} as const satisfies Record<TimeStage, ItemColumn>;
const STAGE_SQL_COLUMN: Record<TimeStage, string> = {
  implementation: "implement_ms",
  fixes: "fix_ms",
  closeout: "closeout_ms",
};

export function* agentTurnStageSteps(q: Q, id: string) {
  const { workItemEvent } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ reason: workItemEvent.reason })
      .from(workItemEvent)
      .where(and(eq(workItemEvent.itemId, id), eq(workItemEvent.kind, "restart")))
      .orderBy(desc(workItemEvent.id))
      .limit(1),
  );
  return agentStage(row?.reason ?? null);
}

export function agentTurnStage(db: Database, id: string): "implementation" | "fixes" {
  return settled(sqliteDb(db).run((q) => agentTurnStageSteps(q, id)));
}

function* setItemSteps(q: Q, id: string, values: Partial<PgWorkItem>) {
  const { workItem } = q.t;
  yield* q.exec(q.orm.update(workItem).set(values).where(eq(workItem.id, id)));
}

export function* saveCheckpointSteps(q: Q, id: string, checkpoint: Checkpoint | null) {
  yield* setItemSteps(q, id, {
    checkpoint: checkpoint === null ? null : jsonValue(q, checkpoint),
  });
}

export function saveCheckpoint(db: Database, id: string, checkpoint: Checkpoint | null): void {
  settled(sqliteDb(db).run((q) => saveCheckpointSteps(q, id, checkpoint)));
}

export function* setRecoveryAttemptsSteps(q: Q, id: string, attempts: number) {
  yield* setItemSteps(q, id, { recoveryAttempts: attempts });
}

export function setRecoveryAttempts(db: Database, id: string, attempts: number): void {
  settled(sqliteDb(db).run((q) => setRecoveryAttemptsSteps(q, id, attempts)));
}

export function* markResumedSteps(q: Q, id: string, now: number) {
  yield* setItemSteps(q, id, { recoveryAttempts: 1, resumedAt: now });
}

export function markResumed(db: Database, id: string, now: number): void {
  settled(sqliteDb(db).run((q) => markResumedSteps(q, id, now)));
}

export function* setCurrentRunSteps(q: Q, id: string, runId: string | null) {
  yield* setItemSteps(q, id, { currentRunId: runId });
}

export function setCurrentRun(db: Database, id: string, runId: string | null): void {
  settled(sqliteDb(db).run((q) => setCurrentRunSteps(q, id, runId)));
}

export function* syncClockSteps(q: Q, id: string, mono: number) {
  yield* setItemSteps(q, id, { lastMonoMs: mono });
}

export function syncClock(db: Database, id: string, mono: number): void {
  settled(sqliteDb(db).run((q) => syncClockSteps(q, id, mono)));
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
            ? [BREAKDOWN_COLUMN.agent, STAGE_SQL_COLUMN[stage!]]
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
           ${STAGE_SQL_COLUMN[stage]} = ${STAGE_SQL_COLUMN[stage]} - ?1,
           waiting_ms = waiting_ms + ?1 WHERE id = ?2`,
        [moved, run.itemId],
      );
  });
}

/** Read ownership and wait flags for each accrual. Pending CI marks are never live. */
function awakeJobActivity(db: Database, itemId: string, now: number, exceptJobId = -1) {
  return settled(sqliteDb(db).run((q) => awakeJobActivitySteps(q, itemId, now, exceptJobId)));
}

function* awakeJobActivitySteps(q: Q, itemId: string, now: number, exceptJobId: number) {
  const { job, workItem, runnerWork, usagePause, agentWait } = q.t;
  const jobs = yield* q.all(
    q.orm
      .select({
        status: job.status,
        lockedUntil: job.lockedUntil,
        lockedBy: job.lockedBy,
        attempts: job.attempts,
        payload: job.payload,
      })
      .from(job)
      .where(
        and(
          eq(jsonField(q, job.payload, "itemId"), itemId),
          inArray(job.status, ["pending", "running"]),
          ne(job.id, exceptJobId),
          advancingQueue(q),
        ),
      ),
  );
  const held = jobs.filter(
    (row) => row.status === "running" && row.lockedUntil !== null && row.lockedUntil > now,
  );
  const waits = held.filter((row) => {
    const wait = (jsonRead(row.payload) as { awakeWait?: Record<string, unknown> } | null)
      ?.awakeWait;
    return (
      typeof wait?.kind === "string" &&
      ["ci", "runner", "backoff"].includes(wait.kind) &&
      wait.worker === row.lockedBy &&
      wait.attempt === row.attempts
    );
  });
  const cutoff = runnerLeaseCutoff(now);
  const currentRun = and(eq(workItem.id, itemId), eq(workItem.currentRunId, runnerWork.runId));
  const leased = and(isNull(runnerWork.endedAt), gt(runnerWork.leaseUntil, cutoff));
  const runner = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(runnerWork)
      .innerJoin(workItem, currentRun)
      .where(leased)
      .limit(1),
  );
  const usage = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(usagePause)
      .innerJoin(workItem, eq(workItem.currentRunId, usagePause.runId))
      .where(eq(workItem.id, itemId))
      .limit(1),
  );
  const agent = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(agentWait)
      .innerJoin(workItem, eq(workItem.currentRunId, agentWait.runId))
      .innerJoin(
        runnerWork,
        and(eq(runnerWork.runId, agentWait.runId), eq(runnerWork.generation, agentWait.generation)),
      )
      .where(and(eq(workItem.id, itemId), leased))
      .limit(1),
  );
  return {
    live: held.length > 0 || runner !== undefined,
    waiting: waits.length > 0 || agent !== undefined,
    usage: usage !== undefined,
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
export function* markCloseoutAcceptedSteps(q: Q, id: string, head: string) {
  yield* setItemSteps(q, id, { acceptedHead: head });
}

export function markCloseoutAccepted(db: Database, id: string, head: string): void {
  settled(sqliteDb(db).run((q) => markCloseoutAcceptedSteps(q, id, head)));
}

function extendAwakeCap(
  db: Database,
  id: string,
  stage: TimeStage,
  extraMs = TIME_LIMIT_EXTENSION_MS,
): void {
  settled(sqliteDb(db).run((q) => extendAwakeCapSteps(q, id, stage, extraMs)));
}

function* extendAwakeCapSteps(q: Q, id: string, stage: TimeStage, extraMs: number) {
  const limit = q.t.workItem[LIMIT_COLUMN[stage]];
  const spent = q.t.workItem[STAGE_COLUMN[stage]];
  const larger =
    q.dialect === "sqlite" ? sql`MAX(${limit}, ${spent})` : sql`GREATEST(${limit}, ${spent})`;
  yield* setItemSteps(q, id, { [LIMIT_COLUMN[stage]]: sql`${larger} + ${extraMs}` });
}

/** Zeroes the awake clock and its breakdown when a stopped task is started again. */
export function* resetAwakeTimeSteps(q: Q, id: string) {
  yield* setItemSteps(q, id, {
    awakeMs: 0,
    agentMs: 0,
    implementMs: 0,
    fixMs: 0,
    closeoutMs: 0,
    waitingMs: 0,
    recheckMs: 0,
    lastMonoMs: null,
  });
}

export function resetAwakeTime(db: Database, id: string): void {
  settled(sqliteDb(db).run((q) => resetAwakeTimeSteps(q, id)));
}

export function* resetStageTimeSteps(q: Q, id: string, stage: TimeStage) {
  yield* setItemSteps(q, id, { [STAGE_COLUMN[stage]]: 0 });
}

export function resetStageTime(db: Database, id: string, stage: TimeStage): void {
  settled(sqliteDb(db).run((q) => resetStageTimeSteps(q, id, stage)));
}

/**
 * Cancels the agent's pending start and resume jobs at the time limit, and the Closeout
 * run of work not yet accepted. Merge jobs stay: Paws keeps publishing and merging
 * accepted work.
 */
function cancelAgentJobs(db: Database, itemId: string, now: number, closeout = false): void {
  settled(sqliteDb(db).run((q) => cancelAgentJobsSteps(q, itemId, now, closeout)));
}

function* cancelAgentJobsSteps(q: Q, itemId: string, now: number, closeout: boolean) {
  const { job } = q.t;
  const queues: string[] = [JOB_KIND.start, JOB_KIND.resume];
  if (closeout) queues.push(JOB_KIND.reverify);
  yield* q.exec(
    q.orm
      .update(job)
      .set({
        status: "cancelled",
        lastError: "time_limit",
        lockedBy: null,
        lockedUntil: null,
        finishedAt: now,
      })
      .where(
        and(
          inArray(job.status, ["pending", "running"]),
          inArray(job.queue, queues),
          eq(jsonField(q, job.payload, "itemId"), itemId),
        ),
      ),
  );
}

/** A resume the time limit cancelled before the agent started it, with its handoff. */
export type HeldHandoff = { jobId: number; handoff: string };

/**
 * Handoffs of resume jobs the time limit cancelled that no later restart carried yet, oldest
 * first. A review or comment restart that the cap cut off waits here for a Continue answer.
 */
export function* heldHandoffsSteps(q: Q, itemId: string) {
  const { job } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ id: job.id, handoff: jsonValueAt(q, job.payload, "handoff") })
      .from(job)
      .where(
        and(
          eq(job.queue, JOB_KIND.resume),
          eq(job.status, "cancelled"),
          eq(job.lastError, "time_limit"),
          eq(jsonField(q, job.payload, "itemId"), itemId),
        ),
      )
      .orderBy(asc(job.id)),
  );
  return rows.flatMap((row): HeldHandoff[] =>
    typeof row.handoff === "string" && row.handoff.trim() !== ""
      ? [{ jobId: row.id, handoff: row.handoff }]
      : [],
  );
}

export function heldHandoffs(db: Database, itemId: string): HeldHandoff[] {
  return settled(sqliteDb(db).run((q) => heldHandoffsSteps(q, itemId)));
}

/** Marks held handoffs as carried by a later restart, so none reaches the agent twice. */
export function* markHandoffsCarriedSteps(q: Q, held: readonly HeldHandoff[]) {
  const { job } = q.t;
  for (const entry of held)
    yield* q.exec(
      q.orm.update(job).set({ lastError: "time_limit_carried" }).where(eq(job.id, entry.jobId)),
    );
}

export function markHandoffsCarried(db: Database, held: readonly HeldHandoff[]): void {
  settled(sqliteDb(db).run((q) => markHandoffsCarriedSteps(q, held)));
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

export function* cancelAdvancingJobsSteps(q: Q, itemId: string, reason: string, now: number) {
  const { job } = q.t;
  yield* q.exec(
    q.orm
      .update(job)
      .set({ status: "cancelled", lastError: reason, finishedAt: now })
      .where(
        and(
          eq(job.status, "pending"),
          eq(jsonField(q, job.payload, "itemId"), itemId),
          advancingQueue(q),
        ),
      ),
  );
}

export function cancelAdvancingJobs(
  db: Database,
  itemId: string,
  reason: string,
  now: number,
): void {
  settled(sqliteDb(db).run((q) => cancelAdvancingJobsSteps(q, itemId, reason, now)));
}

function advancingQueue(q: Q) {
  const { job } = q.t;
  return or(
    inArray(job.queue, [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify, JOB_KIND.merge]),
    likeText(q, job.queue, `${JOB_KIND.merge}.%`),
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

export function* reviewerFaultHoldsSteps(q: Q, reviewer: string) {
  const { job } = q.t;
  const itemId = jsonField(q, job.payload, "itemId");
  const rows = yield* q.all(
    q.orm
      .select({ itemId: sql<string>`${itemId}` })
      .from(job)
      .where(
        and(
          eq(job.queue, JOB_KIND.reverify),
          eq(job.status, "pending"),
          eq(jsonField(q, job.payload, "reviewerFault"), reviewer),
        ),
      )
      .groupBy(itemId)
      .orderBy(min(job.id)),
  );
  const items: WorkItemRecord[] = [];
  for (const row of rows) {
    const item = yield* getWorkItemSteps(q, row.itemId);
    if (item !== null) items.push(item);
  }
  return items;
}

export function reviewerFaultHolds(db: Database, reviewer: string): WorkItemRecord[] {
  return settled(sqliteDb(db).run((q) => reviewerFaultHoldsSteps(q, reviewer)));
}

export function* reviewerAlertedSinceSteps(q: Q, reviewer: string, since: number) {
  const { outbox } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        and(
          likeText(q, outbox.idempotencyKey, `${REVIEWER_ALERT}${reviewer}:%`),
          gte(outbox.createdAt, since),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export function reviewerAlertedSince(db: Database, reviewer: string, since: number): boolean {
  return settled(sqliteDb(db).run((q) => reviewerAlertedSinceSteps(q, reviewer, since)));
}

export function* releaseReviewerFaultHoldsSteps(q: Q, itemId: string, now: number) {
  const { job } = q.t;
  const released =
    q.dialect === "sqlite"
      ? sql`json_remove(${job.payload}, '$.closeoutFaults', '$.reviewerFault')`
      : sql`${job.payload} - 'closeoutFaults' - 'reviewerFault'`;
  const rows = yield* q.all(
    q.orm
      .update(job)
      .set({ runAt: now, payload: released })
      .where(
        and(
          eq(job.queue, JOB_KIND.reverify),
          eq(job.status, "pending"),
          eq(jsonField(q, job.payload, "itemId"), itemId),
          isNotNull(jsonField(q, job.payload, "reviewerFault")),
        ),
      )
      .returning({ id: job.id }),
  );
  return rows.length;
}

export function releaseReviewerFaultHolds(db: Database, itemId: string, now: number): number {
  return settled(sqliteDb(db).run((q) => releaseReviewerFaultHoldsSteps(q, itemId, now)));
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

type ItemRow = {
  item: PgWorkItem;
  continuesItemId: string | null;
  continuesBranch: string | null;
};

function mapItem({ item: row, continuesItemId, continuesBranch }: ItemRow): WorkItemRecord {
  return {
    id: row.id,
    taskKey: row.taskKey,
    delegationId: row.delegationId,
    linearIssueId: row.linearIssueId,
    linearIdentifier: row.linearIdentifier,
    title: row.title,
    state: row.state as WorkItemState,
    branchName: row.branchName,
    continuesItemId: continuesItemId ?? null,
    continuesBranch: continuesBranch ?? null,
    position: row.position,
    version: row.version,
    checkpoint: row.checkpoint === null ? null : readCheckpoint(jsonText(row.checkpoint)),
    recoveryAttempts: row.recoveryAttempts,
    resumedAt: row.resumedAt,
    awakeMs: row.awakeMs,
    lastMonoMs: row.lastMonoMs,
    maxAwakeMs: row.maxAwakeMs,
    maxFixMs: row.maxFixMs ?? 0,
    maxCloseoutMs: row.maxCloseoutMs ?? 0,
    linearProjectId: row.linearProjectId ?? null,
    acceptedHead: row.acceptedHead ?? null,
    agentMs: row.agentMs ?? 0,
    implementMs: row.implementMs ?? 0,
    fixMs: row.fixMs ?? 0,
    closeoutMs: row.closeoutMs ?? 0,
    waitingMs: row.waitingMs ?? 0,
    recheckMs: row.recheckMs ?? 0,
    cancelRequested: row.cancelRequested === 1,
    sessionKey: row.sessionKey,
    currentRunId: row.currentRunId,
    brief: row.brief === null ? null : (jsonRead(row.brief) as WorkBrief),
  };
}

function jsonRead(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function jsonText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function jsonValue(q: Q, value: unknown): unknown {
  return q.dialect === "sqlite" ? JSON.stringify(value) : value;
}

function jsonField(q: Q, column: AnyColumn, key: string): SQL {
  return q.dialect === "sqlite"
    ? sql`json_extract(${column}, ${sql.raw(`'$.${key}'`)})`
    : sql`${column}->>${sql.raw(`'${key}'`)}`;
}

function jsonValueAt(q: Q, column: AnyColumn, key: string): SQL<unknown> {
  return q.dialect === "sqlite"
    ? jsonField(q, column, key)
    : sql`${column}->${sql.raw(`'${key}'`)}`;
}

function likeText(q: Q, column: AnyColumn, pattern: string): SQL {
  return q.dialect === "sqlite" ? like(column, pattern) : ilike(column, pattern);
}

export function* itemDelegationIdSteps(q: Q, itemId: string) {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm.select({ id: workItem.delegationId }).from(workItem).where(eq(workItem.id, itemId)),
  );
  return row?.id ?? null;
}

export function itemDelegationId(db: Database, itemId: string): string | null {
  return settled(sqliteDb(db).run((q) => itemDelegationIdSteps(q, itemId)));
}

export function* itemLinearIdentifierSteps(q: Q, itemId: string) {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm.select({ name: workItem.linearIdentifier }).from(workItem).where(eq(workItem.id, itemId)),
  );
  return row?.name ?? null;
}

export function itemLinearIdentifier(db: Database, itemId: string): string | null {
  return settled(sqliteDb(db).run((q) => itemLinearIdentifierSteps(q, itemId)));
}

export function* lastItemEventSteps(q: Q, itemId: string) {
  const { workItemEvent } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ kind: workItemEvent.kind, reason: workItemEvent.reason })
      .from(workItemEvent)
      .where(eq(workItemEvent.itemId, itemId))
      .orderBy(desc(workItemEvent.id))
      .limit(1),
  );
  return row ?? null;
}

export function lastItemEvent(
  db: Database,
  itemId: string,
): { kind: string; reason: string | null } | null {
  return settled(sqliteDb(db).run((q) => lastItemEventSteps(q, itemId)));
}
