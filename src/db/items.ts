import { pendingRestartHandoffSteps } from "./restart";
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
import { settled, sqliteDb, type Db, type Q, type Steps } from "./db";
import { haltSteps } from "./halt";
import { jsonField as jsonPath } from "./json-text";
import { wakeMergesBehindSteps } from "./merge-queue";
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
import { cancelOpenJobsSteps, emitJobReady, enqueueJobOnceSteps, type Job } from "./jobs";
import { journal } from "./journal";
import { enqueueOutboxOnceSteps } from "./outbox";
import { getLinearSessionGenerationSteps } from "./linear-sessions";
import { withOpenFindingsSteps } from "./open-findings";
import { getRunSteps, markRunSteps, releaseRunCapacitySteps } from "./runs";
import {
  endMergeCallSteps,
  getConfirmedRemoteMergeSteps,
  mergeStopRequestedSteps,
} from "./remote-merges";
import { getPullRequestDraftSteps } from "./pull-request-drafts";
import type { workItem as pgWorkItem } from "./schema-pg";
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

export function* listInFlightItemsSteps(q: Q): Steps<WorkItemRecord[]> {
  return yield* listWorkItemsByStatesSteps(q, IN_FLIGHT_ITEM_STATES);
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

function* requireWorkItemSteps(q: Q, id: string): Steps<WorkItemRecord> {
  const item = yield* getWorkItemSteps(q, id);
  if (item === null) throw new Error(`work item ${id} not found`);
  return item;
}

export function* applyWorkItemEventSteps(
  q: Q,
  id: string,
  event: WorkItemEvent,
  record: WorkItemEventRecord = {},
): Steps<WorkItemRecord> {
  const { workItem, workItemEvent, itemReconciliationRequest } = q.t;
  const current = yield* requireWorkItemSteps(q, id);
  const result = transition(current.state, event);
  if (!result.ok) {
    throw new TransitionRejectedError(result.reason);
  }
  if (event === "take_over") yield* haltSteps(q, current, record.now ?? Date.now());
  // A state whose time is not tracked at all (queued, the merge queue) drops the awake clock's
  // baseline, so the next counted state starts from its own first tick. Otherwise hours in the
  // merge queue would count as agent time once a review sends the item back to the agent.
  const untracked = awakeCategory(result.to, null) === null;
  const updated = yield* q.all(
    q.orm
      .update(workItem)
      .set({
        state: result.to,
        version: sql`${workItem.version} + 1`,
        ...(untracked ? { lastMonoMs: null } : {}),
      })
      .where(and(eq(workItem.id, id), eq(workItem.state, current.state)))
      .returning({ id: workItem.id }),
  );
  if (updated.length === 0) {
    throw new Error(`work item ${id} changed before ${event}`);
  }
  if (current.state !== result.to) yield* wakeMergesBehindSteps(q, record.now ?? Date.now());
  if (result.to === "cancelled")
    yield* q.exec(
      q.orm.delete(itemReconciliationRequest).where(eq(itemReconciliationRequest.itemId, id)),
    );
  const next = yield* requireWorkItemSteps(q, id);
  yield* q.exec(
    q.orm.insert(workItemEvent).values({
      itemId: id,
      version: next.version,
      at: record.now ?? Date.now(),
      fromState: current.state,
      toState: next.state,
      event,
      kind: record.kind ?? "transition",
      reason: record.reason ?? null,
      payloadDigest: record.payloadDigest ?? null,
      actor: record.actor ?? null,
    }),
  );
  journal(
    `transition ${next.linearIdentifier} ${current.state} --${event}--> ${next.state} v${next.version}`,
  );
  return next;
}

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
  return settled(sqliteDb(db).transaction((q) => applyWorkItemEventSteps(q, id, event, record)));
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

export async function listLastWorkItemEventTimes(store: Db): Promise<Map<string, number>> {
  return store.run((q) => listLastWorkItemEventTimesSteps(q));
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

export async function agentTurnStage(store: Db, id: string): Promise<"implementation" | "fixes"> {
  return store.run((q) => agentTurnStageSteps(q, id));
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

export async function setRecoveryAttempts(store: Db, id: string, attempts: number): Promise<void> {
  await store.run((q) => setRecoveryAttemptsSteps(q, id, attempts));
}

export function* markResumedSteps(q: Q, id: string, now: number) {
  yield* setItemSteps(q, id, { recoveryAttempts: 1, resumedAt: now });
}

export async function markResumed(store: Db, id: string, now: number): Promise<void> {
  await store.run((q) => markResumedSteps(q, id, now));
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

export async function syncClock(store: Db, id: string, mono: number): Promise<void> {
  await store.run((q) => syncClockSteps(q, id, mono));
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

/** An accrual's outcome, and whether it inserted a job the wrapper announces after the commit. */
export type AwakeAccrual = { outcome: CapOutcome; jobReady: boolean };

const BREAKDOWN_COLUMN: Record<AwakeCategory, ItemColumn> = {
  agent: "agentMs",
  closeout: "closeoutMs",
  waiting: "waitingMs",
  recheck: "recheckMs",
};

/** Adds `amount` to each column in the database, so concurrent accruals are not lost. */
function addedTo(q: Q, columns: readonly ItemColumn[], amount: number) {
  return Object.fromEntries(
    columns.map((column) => [column, sql`${q.t.workItem[column]} + ${amount}`]),
  ) as Partial<PgWorkItem>;
}

export function* accrueAwakeSteps(
  q: Q,
  id: string,
  mono: number,
  now: number,
  sinceMono?: number,
  liveJob?: boolean,
  forcedHold?: "slot" | "ci",
): Steps<AwakeAccrual> {
  const current = yield* requireWorkItemSteps(q, id);
  const baseline = sinceMono ?? current.lastMonoMs;
  const delta = baseline === null ? 0 : Math.max(0, mono - baseline);
  const counted = awakeCategory(current.state, current.checkpoint, current.acceptedHead);
  // Only an execution job doing agent or Closeout work spends the budget. Idle running,
  // recovering and verifying items are waiting. Job claims
  // and ends settle the interval before them (accrueAtJobBoundary), so the job status
  // now holds for the whole interval since the last accrual.
  const activity = yield* awakeJobActivitySteps(q, id, now, -1);
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
    category === "agent"
      ? yield* agentTurnStageSteps(q, id)
      : category === "closeout"
        ? "closeout"
        : null;
  if (delta > 0 || (current.lastMonoMs === null && sinceMono === undefined)) {
    const columns =
      category === null
        ? []
        : category === "agent"
          ? [BREAKDOWN_COLUMN.agent, STAGE_COLUMN[stage!]]
          : [BREAKDOWN_COLUMN[category]];
    yield* setItemSteps(q, id, { awakeMs, lastMonoMs: mono, ...addedTo(q, columns, delta) });
  }
  if (!awake) {
    return {
      outcome: { capped: false, item: yield* requireWorkItemSteps(q, id) },
      jobReady: false,
    };
  }
  return yield* enforceCapsSteps(q, id, stage!, now);
}

export async function accrueAwake(
  store: Db,
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
): Promise<CapOutcome> {
  const { outcome, jobReady } = await store.transaction((q) =>
    accrueAwakeSteps(q, id, mono, now, sinceMono, liveJob, forcedHold),
  );
  if (jobReady) emitJobReady(store);
  return outcome;
}

function* refundLostTurnSteps(
  q: Q,
  id: string,
  mono: number,
  now: number,
  lostMs: number,
): Steps<{ refundedMs: number; jobReady: boolean }> {
  const { jobReady } = yield* accrueAwakeSteps(q, id, mono, now);
  const stage = STAGE_COLUMN[yield* agentTurnStageSteps(q, id)];
  const item = yield* requireWorkItemSteps(q, id);
  const refundedMs = Math.max(0, Math.min(lostMs, item[stage], item.agentMs, item.awakeMs));
  if (refundedMs > 0)
    yield* setItemSteps(q, id, {
      awakeMs: item.awakeMs - refundedMs,
      agentMs: item.agentMs - refundedMs,
      [stage]: item[stage] - refundedMs,
    });
  return { refundedMs, jobReady };
}

export async function refundLostTurnAsync(
  store: Db,
  id: string,
  mono: number,
  now: number,
  lostMs: number,
): Promise<number> {
  const { refundedMs, jobReady } = await store.transaction((q) =>
    refundLostTurnSteps(q, id, mono, now, lostMs),
  );
  if (jobReady) emitJobReady(store);
  return refundedMs;
}

type BoundaryJob = { id: number; payload: unknown };

function boundaryItemId(job: BoundaryJob): string | null {
  const itemId = (job.payload as { itemId?: unknown } | null)?.itemId;
  return typeof itemId === "string" ? itemId : null;
}

/** Says whether the accrual inserted a job. */
export function* accrueAtJobBoundarySteps(
  q: Q,
  job: BoundaryJob,
  boundary: "claimed" | "ending",
  mono: number,
  now: number,
): Steps<boolean> {
  const itemId = boundaryItemId(job);
  if (itemId === null) return false;
  const item = yield* getWorkItemSteps(q, itemId);
  if (item === null) return false;
  // The claim ends a parked slot wait. Settle that interval as waiting before the attempt.
  if (boundary === "claimed" && runnerCapacityWait(job.payload) && isAwakeItemState(item.state)) {
    const accrued = yield* accrueAwakeSteps(q, itemId, mono, now, undefined, false, "slot");
    return accrued.jobReady;
  }
  if (!isAwakeItemState(item.state) && boundary !== "claimed") return false;
  const activity = yield* awakeJobActivitySteps(
    q,
    itemId,
    now,
    boundary === "claimed" ? job.id : -1,
  );
  const accrued = yield* accrueAwakeSteps(q, itemId, mono, now, undefined, activity.live);
  return accrued.jobReady;
}

/**
 * Settle active time at every execution claim and end. The interval before a claim
 * stays waiting; the final stretch before an execution job ends still counts as work.
 */
export async function accrueAtJobBoundary(
  store: Db,
  job: BoundaryJob,
  boundary: "claimed" | "ending",
  mono: number,
  now: number,
): Promise<void> {
  if (boundaryItemId(job) === null) return;
  const jobReady = await store.transaction((q) =>
    accrueAtJobBoundarySteps(q, job, boundary, mono, now),
  );
  if (jobReady) emitJobReady(store);
}

function awakeWaitItemId(job: Job): string | undefined {
  return (job.payload as { itemId?: string }).itemId;
}

/** Says whether the accrual inserted a job. */
export function* markJobAwakeWaitSteps(
  q: Q,
  job: Job,
  waiting: boolean,
  mono: number,
  now: number,
  reason: "ci" | "runner" | "backoff" = "ci",
): Steps<boolean> {
  const itemId = awakeWaitItemId(job);
  if (!itemId) return false;
  const table = q.t.job;
  const { jobReady } = yield* accrueAwakeSteps(q, itemId, mono, now);
  if (waiting) {
    const marked =
      q.dialect === "sqlite"
        ? sql`json_set(${table.payload}, '$.awakeWait',
            json_object('kind', ${reason}, 'worker', ${table.lockedBy}, 'attempt', ${table.attempts}))`
        : sql`jsonb_set(${table.payload}, '{awakeWait}',
            jsonb_build_object('kind', ${reason}::text, 'worker', ${table.lockedBy}, 'attempt', ${table.attempts}))`;
    yield* q.exec(
      q.orm
        .update(table)
        .set({ payload: marked })
        .where(
          and(
            eq(table.id, job.id),
            eq(table.status, "running"),
            eq(table.lockedBy, job.lockedBy ?? sql`NULL`),
            eq(table.attempts, job.attempts),
            gt(table.lockedUntil, now),
          ),
        ),
    );
  } else {
    const cleared =
      q.dialect === "sqlite"
        ? sql`json_remove(${table.payload}, '$.awakeWait')`
        : sql`${table.payload} - 'awakeWait'`;
    yield* q.exec(
      q.orm
        .update(table)
        .set({ payload: cleared })
        .where(
          and(
            eq(table.id, job.id),
            eq(jsonPath(q, table.payload, "awakeWait", "worker"), job.lockedBy ?? sql`NULL`),
            // Postgres reads the JSON field as text, SQLite as the stored integer.
            eq(
              jsonPath(q, table.payload, "awakeWait", "attempt"),
              q.dialect === "sqlite" ? job.attempts : String(job.attempts),
            ),
          ),
        ),
    );
  }
  return jobReady;
}

/** Wait bookkeeping belongs to one claim. A stale finally may clear only its own mark. */
export async function markJobAwakeWait(
  store: Db,
  job: Job,
  waiting: boolean,
  mono: number,
  now: number,
  reason: "ci" | "runner" | "backoff" = "ci",
): Promise<void> {
  if (!awakeWaitItemId(job)) return;
  const jobReady = await store.transaction((q) =>
    markJobAwakeWaitSteps(q, job, waiting, mono, now, reason),
  );
  if (jobReady) emitJobReady(store);
}

export type AgentWaitRun = { itemId: string; runId: string; generation: number };

/** Says whether the accrual inserted a job. */
export function* startAgentWaitSteps(
  q: Q,
  run: AgentWaitRun,
  mono: number,
  now: number,
): Steps<boolean> {
  const { agentWait } = q.t;
  if ((yield* getWorkItemSteps(q, run.itemId)) === null) return false;
  const { outcome, jobReady } = yield* accrueAwakeSteps(q, run.itemId, mono, now);
  const wait = { generation: run.generation, startedAt: now, waitingMs: outcome.item.waitingMs };
  yield* q.exec(
    q.orm
      .insert(agentWait)
      .values({ runId: run.runId, ...wait })
      .onConflictDoUpdate({ target: agentWait.runId, set: wait }),
  );
  return jobReady;
}

export async function startAgentWait(
  store: Db,
  run: AgentWaitRun,
  mono: number,
  now: number,
): Promise<void> {
  const jobReady = await store.transaction((q) => startAgentWaitSteps(q, run, mono, now));
  if (jobReady) emitJobReady(store);
}

/** Says whether the accrual inserted a job. */
export function* endAgentWaitSteps(
  q: Q,
  run: AgentWaitRun,
  mono: number,
  now: number,
  waitedMs?: number,
): Steps<boolean> {
  const { agentWait } = q.t;
  const open = yield* q.one(
    q.orm
      .select({ waitingMs: agentWait.waitingMs })
      .from(agentWait)
      .where(and(eq(agentWait.runId, run.runId), eq(agentWait.generation, run.generation))),
  );
  if (open === undefined || (yield* getWorkItemSteps(q, run.itemId)) === null) return false;
  const { outcome, jobReady } = yield* accrueAwakeSteps(q, run.itemId, mono, now);
  const item = outcome.item;
  yield* q.exec(q.orm.delete(agentWait).where(eq(agentWait.runId, run.runId)));
  if (waitedMs === undefined) return jobReady;
  const counted = Math.max(0, item.waitingMs - open.waitingMs);
  const stage = yield* agentTurnStageSteps(q, run.itemId);
  const moved = Math.min(
    Math.max(0, waitedMs - counted),
    item.agentMs,
    stage === "implementation" ? item.implementMs : item.fixMs,
  );
  if (moved > 0)
    yield* setItemSteps(q, run.itemId, {
      ...addedTo(q, ["awakeMs", "agentMs", STAGE_COLUMN[stage]], -moved),
      ...addedTo(q, ["waitingMs"], moved),
    });
  return jobReady;
}

export async function endAgentWait(
  store: Db,
  run: AgentWaitRun,
  mono: number,
  now: number,
  waitedMs?: number,
): Promise<void> {
  const jobReady = await store.transaction((q) => endAgentWaitSteps(q, run, mono, now, waitedMs));
  if (jobReady) emitJobReady(store);
}

/** Read ownership and wait flags for each accrual. Pending CI marks are never live. */
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
function* enforceCapsSteps(q: Q, id: string, stage: TimeStage, now: number): Steps<AwakeAccrual> {
  const { job } = q.t;
  const updated = yield* requireWorkItemSteps(q, id);
  const unchanged = { outcome: { capped: false, item: updated }, jobReady: false };
  if (!stageReached(updated, stage)) return unchanged;
  const accepted = updated.acceptedHead !== null;
  if (
    !accepted &&
    (updated.sessionKey === null || (updated.state !== "running" && updated.state !== "verifying"))
  ) {
    yield* failForCapSteps(q, updated, stage, now);
    return { outcome: { capped: true, item: yield* requireWorkItemSteps(q, id) }, jobReady: false };
  }
  if (accepted && updated.state !== "running") return unchanged;
  const asking = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(job)
      .where(
        and(
          eq(job.queue, "item.ask"),
          inArray(job.status, ["pending", "running"]),
          eq(jsonField(q, job.payload, "itemId"), id),
        ),
      )
      .limit(1),
  );
  if (asking !== undefined) return unchanged;
  const { asked, jobReady } = yield* askTimeLimitSteps(q, updated, stage, now);
  if (asked)
    return {
      outcome: {
        capped: false,
        asked: true,
        stopAgent: true,
        item: yield* requireWorkItemSteps(q, id),
      },
      jobReady,
    };
  yield* pauseAtTimeLimitSteps(q, updated, stage, now);
  return {
    outcome: { capped: false, stopAgent: true, item: yield* requireWorkItemSteps(q, id) },
    jobReady: false,
  };
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

export async function markCloseoutAccepted(store: Db, id: string, head: string): Promise<void> {
  await store.run((q) => markCloseoutAcceptedSteps(q, id, head));
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

export async function resetAwakeTime(store: Db, id: string): Promise<void> {
  await store.run((q) => resetAwakeTimeSteps(q, id));
}

export function* resetStageTimeSteps(q: Q, id: string, stage: TimeStage) {
  yield* setItemSteps(q, id, { [STAGE_COLUMN[stage]]: 0 });
}

export async function resetStageTime(store: Db, id: string, stage: TimeStage): Promise<void> {
  await store.run((q) => resetStageTimeSteps(q, id, stage));
}

/**
 * Cancels the agent's pending start and resume jobs at the time limit, and the Closeout
 * run of work not yet accepted. Merge jobs stay: Paws keeps publishing and merging
 * accepted work.
 */
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

export async function heldHandoffs(store: Db, itemId: string): Promise<HeldHandoff[]> {
  return store.run((q) => heldHandoffsSteps(q, itemId));
}

/** Marks held handoffs as carried by a later restart, so none reaches the agent twice. */
export function* markHandoffsCarriedSteps(q: Q, held: readonly HeldHandoff[]) {
  const { job } = q.t;
  for (const entry of held)
    yield* q.exec(
      q.orm.update(job).set({ lastError: "time_limit_carried" }).where(eq(job.id, entry.jobId)),
    );
}

export async function markHandoffsCarried(store: Db, held: readonly HeldHandoff[]): Promise<void> {
  await store.run((q) => markHandoffsCarriedSteps(q, held));
}

/**
 * Without a Linear session to ask in, accepted work pauses at the time limit
 * instead of failing. The cap already allows another hour, so resuming it from
 * the run page keeps going.
 */
function* pauseAtTimeLimitSteps(q: Q, item: WorkItemRecord, stage: TimeStage, now: number) {
  yield* applyWorkItemEventSteps(q, item.id, "pause");
  yield* cancelAgentJobsSteps(q, item.id, now, false);
  if (item.currentRunId !== null) {
    const run = yield* getRunSteps(q, item.currentRunId);
    if (run?.status === "active") yield* markRunSteps(q, run.id, "ended", now);
  }
  yield* extendAwakeCapSteps(q, item.id, stage, TIME_LIMIT_EXTENSION_MS);
  journal(`item ${item.linearIdentifier} reached its time cap after acceptance; paused`);
  yield* enqueueOutboxOnceSteps(q, {
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
function* askTimeLimitSteps(
  q: Q,
  item: WorkItemRecord,
  stage: TimeStage,
  now: number,
): Steps<{ asked: boolean; jobReady: boolean }> {
  const sessionId = item.sessionKey;
  if (sessionId === null) return { asked: false, jobReady: false };
  const accepted = item.acceptedHead !== null;
  const verifying = item.state === "verifying";
  yield* cancelAgentJobsSteps(q, item.id, now, !accepted);
  const held = (yield* heldHandoffsSteps(q, item.id)).length > 0;
  if (accepted && item.currentRunId) yield* releaseRunCapacitySteps(q, item.currentRunId, now);
  const { inserted } = yield* enqueueJobOnceSteps(q, {
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
  return { asked: true, jobReady: inserted };
}

export function* failWorkItemSteps(
  q: Q,
  item: WorkItemRecord,
  reason: string,
  text: string,
  now: number,
  options: { stoppedByAnswer?: boolean } = {},
): Steps<boolean> {
  const current = yield* getWorkItemSteps(q, item.id);
  if (
    current === null ||
    current.version !== item.version ||
    current.currentRunId !== item.currentRunId ||
    current.state === "failed" ||
    isTerminalWorkItemState(current.state)
  )
    return false;
  yield* commitFailureSteps(
    q,
    current,
    reason,
    text,
    now,
    (version) => `fail:${item.id}:${version}:${reason}`,
    options.stoppedByAnswer === true,
  );
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
  return settled(
    sqliteDb(db).transaction((q) => failWorkItemSteps(q, item, reason, text, now, options)),
  );
}

type CompleteMergedInput = {
  itemId: string;
  now: number;
  announce?: (item: WorkItemRecord) => void;
};

export function* completeMergedItemSteps(
  q: Q,
  input: CompleteMergedInput,
): Steps<WorkItemRecord | null> {
  const current = yield* getWorkItemSteps(q, input.itemId);
  if (current === null || current.state !== "merge_queue" || current.cancelRequested) return null;
  const fact = yield* getConfirmedRemoteMergeSteps(q, current.id);
  if (fact === null) return null;
  const sessionId = current.sessionKey ?? current.id;
  const generation = yield* getLinearSessionGenerationSteps(q, sessionId);
  yield* enqueueOutboxOnceSteps(q, {
    target: "linear",
    op: "activity",
    orderingKey: sessionId,
    delivery: (yield* mergeStopRequestedSteps(q, current.id)) ? "stop" : "ordered",
    generation,
    idempotencyKey: `merged:${current.id}:${generation}`,
    payload: {
      sessionId,
      itemId: current.id,
      kind: "response",
      body: yield* withOpenFindingsSteps(
        q,
        current.id,
        `Merged #${fact.pullNumber} into main at ${fact.mergeSha ?? "unknown commit"}. ${current.linearIdentifier} is Done.`,
      ),
    },
    now: input.now,
  });
  const remaining = (yield* getPullRequestDraftSteps(q, current.id))?.remaining;
  if (remaining?.length)
    yield* enqueueOutboxOnceSteps(q, {
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
  const merged = yield* applyWorkItemEventSteps(q, current.id, "merge_accepted", {
    now: input.now,
  });
  yield* endMergeCallSteps(q, current.id);
  yield* endActiveRunSteps(q, current.currentRunId, input.now);
  yield* cancelAdvancingJobsSteps(q, current.id, "merged", input.now);
  return merged;
}

export async function completeMergedItem(
  store: Db,
  input: {
    itemId: string;
    now: number;
    announce?: (item: WorkItemRecord) => void;
  },
): Promise<WorkItemRecord | null> {
  return store.transaction((q) => completeMergedItemSteps(q, input));
}

function* endActiveRunSteps(q: Q, runId: string | null, now: number) {
  if (runId === null) return;
  const run = yield* getRunSteps(q, runId);
  if (run && (run.status === "active" || run.status === "provisioning"))
    yield* markRunSteps(q, runId, "ended", now);
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

export async function cancelAdvancingJobs(
  store: Db,
  itemId: string,
  reason: string,
  now: number,
): Promise<void> {
  await store.run((q) => cancelAdvancingJobsSteps(q, itemId, reason, now));
}

function advancingQueue(q: Q) {
  const { job } = q.t;
  return or(
    inArray(job.queue, [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify, JOB_KIND.merge]),
    likeText(q, job.queue, `${JOB_KIND.merge}.%`),
  );
}

type DeferInput = {
  retry: number;
  delayMs: number;
  handoff: string | null;
  message: string | null;
  now: number;
  lastError?: string;
  capacityWait?: RunnerCapacityWaitState;
  closeoutFault?: CloseoutFaults & { jobId: number; reviewer?: string };
};

/** Says whether the deferral inserted a job. */
export function* deferWorkItemSteps(q: Q, item: WorkItemRecord, input: DeferInput): Steps<boolean> {
  const before = (yield* getWorkItemSteps(q, item.id)) ?? item;
  const reverify = before.state === "verifying" && hasVerificationCandidate(before.checkpoint);
  if (!reverify && (item.state === "running" || item.state === "verifying"))
    yield* applyWorkItemEventSteps(q, item.id, "deferred");
  const current = (yield* getWorkItemSteps(q, item.id)) ?? item;
  journal(
    `item ${item.linearIdentifier} deferred: ${reverify ? "re-verify" : "retry"} ${input.retry} in ${input.delayMs} ms`,
  );
  if (current.currentRunId !== null) {
    const run = yield* getRunSteps(q, current.currentRunId);
    if (run && (run.status === "active" || run.status === "provisioning"))
      yield* markRunSteps(q, run.id, "lost", input.now);
  }
  const capacityWait = input.capacityWait ? { capacityWait: input.capacityWait } : {};
  const lastError = input.lastError === undefined ? {} : { lastError: input.lastError };
  const fault = input.closeoutFault;
  const { inserted } =
    reverify && fault
      ? yield* enqueueJobOnceSteps(q, {
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
        })
      : reverify
        ? yield* enqueueJobOnceSteps(q, {
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
          })
        : yield* enqueueJobOnceSteps(q, {
            queue: JOB_KIND.resume,
            jobKey: `resume:${item.id}:${current.version}`,
            runAt: input.now + input.delayMs,
            payload: {
              itemId: item.id,
              runId: current.currentRunId,
              reason: "transient_failure",
              retry: input.retry,
              ...(yield* pendingRestartHandoffSteps(q, item.id)),
              ...(input.handoff === null ? {} : { handoff: input.handoff }),
              ...capacityWait,
              ...lastError,
            },
            now: input.now,
          });
  if (input.message !== null)
    yield* enqueueOutboxOnceSteps(q, {
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
  return inserted;
}

export async function deferWorkItem(
  store: Db,
  item: WorkItemRecord,
  input: DeferInput,
): Promise<void> {
  if (await store.transaction((q) => deferWorkItemSteps(q, item, input))) emitJobReady(store);
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

export async function reviewerFaultHolds(store: Db, reviewer: string): Promise<WorkItemRecord[]> {
  return store.run((q) => reviewerFaultHoldsSteps(q, reviewer));
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

export async function reviewerAlertedSince(
  store: Db,
  reviewer: string,
  since: number,
): Promise<boolean> {
  return store.run((q) => reviewerAlertedSinceSteps(q, reviewer, since));
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

function* failForCapSteps(q: Q, item: WorkItemRecord, stage: TimeStage, now: number) {
  yield* commitFailureSteps(
    q,
    item,
    "cap:time",
    capActivityText(stage, stageLimits(item), awakeBreakdown(item)),
    now,
    (version) => `cap:${item.id}:${version}:time`,
  );
}

function* commitFailureSteps(
  q: Q,
  item: WorkItemRecord,
  reason: string,
  text: string,
  now: number,
  idempotencyKey: (version: number) => string,
  stoppedByAnswer = false,
) {
  const { outbox } = q.t;
  const version = yield* moveToFailedSteps(q, item, stoppedByAnswer);
  journal(`item ${item.linearIdentifier} failed: ${reason}`);
  yield* setItemSteps(q, item.id, { cancelRequested: 1 });
  if (item.currentRunId !== null) yield* markRunSteps(q, item.currentRunId, "lost", now);
  yield* cancelOpenJobsSteps(q, { itemId: item.id, reason, now });
  const sessionId = item.sessionKey ?? item.id;
  const generation = yield* getLinearSessionGenerationSteps(q, sessionId);
  const afterPr =
    (yield* q.one(
      q.orm
        .select({ one: sql`1` })
        .from(outbox)
        .where(
          and(
            eq(outbox.target, "linear"),
            eq(outbox.orderingKey, sessionId),
            eq(outbox.deliveryGeneration, generation),
            likeText(q, outbox.idempotencyKey, "pull-request-ready:%"),
            ne(outbox.status, "dropped"),
          ),
        )
        .limit(1),
    )) !== undefined;
  yield* enqueueOutboxOnceSteps(q, {
    target: OUTBOX_ACTIVITY.target,
    op: OUTBOX_ACTIVITY.op,
    orderingKey: sessionId,
    ...(afterPr ? { delivery: "ordered" as const, generation } : {}),
    idempotencyKey: afterPr ? `closed:${item.id}:${generation}` : idempotencyKey(version),
    payload: {
      sessionId,
      kind: afterPr ? "response" : "error",
      body: afterPr ? yield* withOpenFindingsSteps(q, item.id, `Closed: ${text}`) : text,
    },
    now,
  });
}

function* moveToFailedSteps(q: Q, item: WorkItemRecord, stopped: boolean): Steps<number> {
  if (item.state === "failed") return item.version;
  const event =
    stopped && item.state === "awaiting_input" ? "answer_stopped" : failureEvent(item.state);
  if (event === null) {
    throw new TransitionRejectedError("illegal_transition");
  }
  return (yield* applyWorkItemEventSteps(q, item.id, event)).version;
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

export async function itemDelegationId(store: Db, itemId: string): Promise<string | null> {
  return store.run((q) => itemDelegationIdSteps(q, itemId));
}

export function* itemLinearIdentifierSteps(q: Q, itemId: string) {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm.select({ name: workItem.linearIdentifier }).from(workItem).where(eq(workItem.id, itemId)),
  );
  return row?.name ?? null;
}

export async function itemLinearIdentifier(store: Db, itemId: string): Promise<string | null> {
  return store.run((q) => itemLinearIdentifierSteps(q, itemId));
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

export async function lastItemEvent(
  store: Db,
  itemId: string,
): Promise<{ kind: string; reason: string | null } | null> {
  return store.run((q) => lastItemEventSteps(q, itemId));
}

/** The Linear session key of each of these work items that exists. */
export async function workItemSessionKeys(
  store: Db,
  ids: readonly string[],
): Promise<{ id: string; sessionKey: string | null }[]> {
  return store.run((q) => workItemSessionKeysSteps(q, ids));
}

export function* workItemSessionKeysSteps(q: Q, ids: readonly string[]) {
  if (ids.length === 0) return [];
  const { workItem } = q.t;
  return yield* q.all(
    q.orm
      .select({ id: workItem.id, sessionKey: workItem.sessionKey })
      .from(workItem)
      .where(inArray(workItem.id, [...ids])),
  );
}

export type WakeRecord = { fromWall: number; toWall: number; sleptMs: number; now: number };

export function* recordWakeSteps(q: Q, input: WakeRecord) {
  const { wake } = q.t;
  const inserted = yield* q.all(
    q.orm
      .insert(wake)
      .values({
        fromWall: input.fromWall,
        toWall: input.toWall,
        sleptMs: input.sleptMs,
        createdAt: input.now,
      })
      .onConflictDoNothing({ target: wake.fromWall })
      .returning({ fromWall: wake.fromWall }),
  );
  return inserted.length > 0;
}

export async function recordWake(store: Db, input: WakeRecord): Promise<boolean> {
  return store.run((q) => recordWakeSteps(q, input));
}
