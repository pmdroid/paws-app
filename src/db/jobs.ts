import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql as drizzleSql,
  type SQL,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  DEFAULT_LEASE_MS,
  isMergeWork,
  JOB_KIND,
  MERGE_WORK,
  retryAfterMs,
  retryBackoffMs,
} from "../core";
import { type Db, type Q } from "./db";
import { journal } from "./journal";
import { jsonField, jsonText } from "./json-text";

export const JOB_STATUSES = ["pending", "running", "done", "dead", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type NewJob = {
  queue: string;
  payload?: unknown;
  jobKey?: string;
  priority?: number;
  runAt?: number;
  maxAttempts?: number;
  recurringEveryMs?: number;
  /** Clock injection for tests. Defaults to Date.now(). */
  now?: number;
};

export type Job = {
  id: number;
  /** Immutable identity of this use of a durable logical job row. */
  activationId: number;
  queue: string;
  jobKey: string | null;
  payload: unknown;
  priority: number;
  runAt: number;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lockedBy: string | null;
  lockedUntil: number | null;
  lastError: string | null;
  createdAt: number;
  finishedAt: number | null;
  recurringEveryMs: number | null;
  fireCount: number;
};

type JobRow = Q["t"]["job"]["$inferSelect"];

export type ClaimOptions = {
  workerId?: string;
  leaseMs?: number;
  now?: number;
  /** When set, only these queues are eligible. An empty list claims nothing. */
  queues?: readonly string[];
};

const EXCLUSIVE_QUEUES = [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify] as const;

/** The text at `key` of a JSON value: `json_extract` on SQLite, `->>` on Postgres. */
function jsonTextSql(dialect: Q["dialect"], json: string, key: string): string {
  return dialect === "sqlite" ? `json_extract(${json}, '$.${key}')` : `(${json}->>'${key}')`;
}

export function jsonItemId(q: Q, json: SQL): SQL<string | null> {
  return q.dialect === "sqlite"
    ? drizzleSql`json_extract(${json},'$.itemId')`
    : drizzleSql`(${json}->>'itemId')`;
}

function jobItemId(q: Q): SQL<string | null> {
  return jsonItemId(q, drizzleSql`${q.t.job.payload}`);
}

/** The JSON text bound as a parameter, cast to jsonb on Postgres. */
function jsonParam(q: Q, text: string): SQL {
  return q.dialect === "sqlite" ? drizzleSql`${text}` : drizzleSql`${text}::text::jsonb`;
}

/** A payload as the column stores it: JSON text on SQLite, jsonb on Postgres. */
function payloadValue(q: Q, payload: unknown): string {
  return (q.dialect === "sqlite" ? JSON.stringify(payload) : payload) as string;
}

export function itemVersionOf(q: Q, payload: SQL): SQL<number | null> {
  return drizzleSql`(SELECT version FROM work_item WHERE id=${jsonItemId(q, payload)})`;
}

function claimable(q: Q, now: number): SQL | undefined {
  const { job } = q.t;
  return or(
    eq(job.status, "pending"),
    and(eq(job.status, "running"), or(isNull(job.lockedUntil), lte(job.lockedUntil, now))),
  );
}

function* updateLeasedSteps(
  q: Q,
  lease: Job,
  set: Partial<{ [K in keyof JobRow]: JobRow[K] | SQL }>,
  extra?: SQL,
) {
  const { job } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(job)
      .set(set)
      .where(
        and(
          eq(job.id, lease.id),
          eq(job.status, "running"),
          eq(job.lockedBy, lease.lockedBy ?? drizzleSql`NULL`),
          extra,
        ),
      )
      .returning({ id: job.id }),
  );
  return rows.length;
}

type JobReadySource = Database | Db;

const jobReadyListeners = new Set<(db: JobReadySource) => void>();

/** Fires after a job row is inserted. The job loop wakes its claimer from this. */
export function onJobReady(listener: (db: JobReadySource) => void): () => void {
  jobReadyListeners.add(listener);
  return () => {
    jobReadyListeners.delete(listener);
  };
}

/** Wake the job loop after a wrapper ran a …Steps that inserted a job row. */
export function emitJobReady(db: JobReadySource): void {
  for (const listener of jobReadyListeners) {
    try {
      listener(db);
    } catch (error) {
      journalCaught(error, "jobs.enqueueJob.emitJobReady", null);
    }
  }
}

/** The synchronous wrapper callers use until they become async. */
function sqlLiteral(value: string): string {
  if (!/^[A-Za-z0-9._%:-]+$/.test(value)) throw new Error(`unsafe SQL literal: ${value}`);
  return `'${value}'`;
}

export function mergeLaneSql(alias: string): string {
  return `(${alias}.queue = ${sqlLiteral(MERGE_WORK.queue)} OR ${alias}.queue LIKE ${sqlLiteral(`${MERGE_WORK.queuePrefix}%`)})`;
}

function executionSql(alias: string): string {
  return `(${alias}.queue IN (${EXCLUSIVE_QUEUES.map(sqlLiteral).join(", ")}))`;
}

/**
 * Shared by the claim and by the health check, over `job AS candidate`.
 *
 * Queued starts and restarts need the scheduler's reservation. A start parked for a runner
 * slot already began, so it is claimed again without a new reservation (PAS-898). Jobs for
 * the same item and merge jobs in the same merge lane cannot hold overlapping leases. Other
 * items run independently.
 */
function claimWhere(q: Q, now: number, queues?: readonly string[]): SQL {
  const raw = drizzleSql.raw;
  const itemId = `COALESCE(${jsonTextSql(q.dialect, "candidate.payload", "itemId")}, '')`;
  const heldItemId = `COALESCE(${jsonTextSql(q.dialect, "held.payload", "itemId")},'')`;
  const needsReservation = `((candidate.queue = ${sqlLiteral(JOB_KIND.start)}
  AND (${jsonTextSql(q.dialect, "candidate.payload", "capacityWait")} IS NULL OR EXISTS
    (SELECT 1 FROM work_item mine WHERE mine.id=${itemId} AND mine.state='queued'))) OR
  (candidate.queue = ${sqlLiteral(JOB_KIND.resume)} AND EXISTS
    (SELECT 1 FROM work_item mine WHERE mine.id=${itemId} AND mine.state='queued')))`;
  const reservation = `EXISTS (SELECT 1 FROM scheduler_admission a JOIN work_item mine ON mine.id=a.item_id
  WHERE a.item_id=${itemId} AND a.job_id=candidate.id AND mine.state='queued' AND mine.cancel_requested=0
  AND NOT EXISTS(SELECT 1 FROM run live WHERE live.item_id=mine.id AND live.status IN ('active','provisioning')))`;
  const sameLane = `EXISTS (SELECT 1 FROM merge_queue_entry place JOIN work_item placed ON placed.id = place.item_id
      WHERE place.item_id = ${heldItemId}
        AND placed.state = 'merge_queue' AND placed.cancel_requested = 0
        AND place.lane = COALESCE((SELECT own.lane FROM merge_queue_entry own WHERE own.item_id = ${itemId}), ''))
    AND NOT (EXISTS (SELECT 1 FROM work_item_repository mine
    JOIN work_item_repository other ON other.item_id = ${heldItemId}
    WHERE mine.item_id = ${itemId}
      AND (lower(mine.owner) != lower(other.owner) OR lower(mine.repo) != lower(other.repo))))`;
  const queueFilter =
    queues === undefined
      ? drizzleSql``
      : drizzleSql` AND candidate.queue IN (${drizzleSql.join(
          queues.map((queue) => drizzleSql`${queue}`),
          drizzleSql`, `,
        )})`;
  return drizzleSql`candidate.run_at <= ${now}${queueFilter}
    AND (candidate.status = 'pending' OR (candidate.status = 'running' AND (candidate.locked_until IS NULL OR candidate.locked_until <= ${now})))
    AND NOT (${raw(needsReservation)} AND NOT (${raw(reservation)}))
    AND NOT (${raw(mergeLaneSql("candidate"))} AND EXISTS (SELECT 1 FROM job held WHERE held.id != candidate.id AND held.status = 'running'
      AND (held.locked_until IS NULL OR held.locked_until > ${now}) AND ${raw(mergeLaneSql("held"))}
      AND ${raw(sameLane)}))
    AND NOT (${raw(executionSql("candidate"))} AND EXISTS (SELECT 1 FROM job held WHERE held.id != candidate.id AND held.status = 'running'
      AND (held.locked_until IS NULL OR held.locked_until > ${now}) AND (${raw(executionSql("held"))} OR ${raw(mergeLaneSql("held"))})
      AND ${raw(heldItemId)} = ${raw(itemId)}))`;
}

export function* actionableDueSteps(q: Q, now: number) {
  const row = yield* q.one(
    q.orm
      .select({
        count: drizzleSql<number>`count(*)`.mapWith(Number),
        oldest: drizzleSql<number | null>`min(candidate.run_at)`.mapWith(Number),
      })
      .from(drizzleSql`job AS candidate`)
      .where(claimWhere(q, now)),
  );
  return { count: row?.count ?? 0, oldestRunAt: row?.oldest ?? null };
}

/** Due work the loop could claim right now. A start without a reservation is not included. */
export async function actionableDue(
  store: Db,
  now: number,
): Promise<{ count: number; oldestRunAt: number | null }> {
  return store.run((q) => actionableDueSteps(q, now));
}

function* insertJobSteps(q: Q, input: NewJob, skipDuplicateKey: boolean) {
  const { job } = q.t;
  const now = input.now ?? Date.now();
  const payload = input.payload ?? {};
  const insert = q.orm.insert(job).values({
    queue: input.queue,
    jobKey: input.jobKey ?? null,
    payload: payloadValue(q, payload),
    priority: input.priority ?? 5,
    runAt: input.runAt ?? now,
    maxAttempts: input.maxAttempts ?? 10,
    createdAt: now,
    recurringEveryMs: input.recurringEveryMs ?? null,
    itemVersion: itemVersionOf(q, jsonParam(q, JSON.stringify(payload))),
  });
  const row = yield* q.one(
    (skipDuplicateKey ? insert.onConflictDoNothing({ target: job.jobKey }) : insert).returning({
      id: job.id,
    }),
  );
  return row?.id;
}

export function* enqueueJobSteps(q: Q, input: NewJob) {
  const id = yield* insertJobSteps(q, input, false);
  if (id === undefined) {
    throw new Error("enqueueJob did not return an id");
  }
  return id;
}

/** Insert in the same transaction as the state change that needs the work. */
export async function enqueueJob(store: Db, job: NewJob): Promise<number> {
  const id = await store.transaction((q) => enqueueJobSteps(q, job));
  emitJobReady(store);
  return id;
}

/**
 * Return the open row for this key when one exists. A finished key cannot be
 * inserted again (`job_key` is unique for the life of the table), so the
 * existing id is returned and the caller keeps the original row. `inserted` says
 * whether this call added the row.
 */
export function* enqueueJobOnceSteps(q: Q, job: NewJob) {
  if (job.jobKey === undefined) return { id: yield* enqueueJobSteps(q, job), inserted: true };
  const existing = yield* findByKeySteps(q, job.jobKey);
  if (existing) return { id: existing.id, inserted: false };
  const id = yield* insertJobSteps(q, job, true);
  if (id !== undefined) return { id, inserted: true };
  const saved = yield* findByKeySteps(q, job.jobKey);
  if (!saved) throw new Error("enqueueJobOnce found no job for its key");
  return { id: saved.id, inserted: false };
}

export async function enqueueJobOnce(store: Db, job: NewJob): Promise<number> {
  const { id, inserted } = await store.transaction((q) => enqueueJobOnceSteps(q, job));
  if (inserted) emitJobReady(store);
  return id;
}

/**
 * Explicitly arm a recurring logical operation. Active rows retain their payload and lease;
 * terminal rows receive fresh work and version fencing. Ordinary lifetime dedupe stays separate.
 * `armed` says whether this call made a row pending.
 */
export function* reenqueueJobSteps(
  q: Q,
  input: NewJob & { jobKey: string },
  payloadFor?: (previous: Job | null) => unknown,
) {
  const { job, jobActivation } = q.t;
  const previous = yield* findByKeySteps(q, input.jobKey);
  if (previous && previous.queue !== input.queue)
    throw new Error("Recurring job key belongs to a different queue");
  if (previous && (previous.status === "pending" || previous.status === "running"))
    return { id: previous.id, pending: previous.status === "pending", armed: false };
  const payload = payloadFor ? payloadFor(previous) : input.payload;
  if (!previous)
    return {
      id: yield* enqueueJobSteps(q, { ...input, payload }),
      pending: true,
      armed: true,
    };
  const activation = (yield* q.one(
    q.orm.insert(jobActivation).values({ jobId: previous.id }).returning({ id: jobActivation.id }),
  ))!;
  const now = input.now ?? Date.now();
  const next = payload ?? {};
  yield* q.exec(
    q.orm
      .update(job)
      .set({
        status: "pending",
        payload: payloadValue(q, next),
        attempts: 0,
        runAt: input.runAt ?? now,
        itemVersion: itemVersionOf(q, jsonParam(q, JSON.stringify(next))),
        activationId: activation.id,
        priority: input.priority ?? 5,
        maxAttempts: input.maxAttempts ?? 10,
        recurringEveryMs: input.recurringEveryMs ?? null,
        lockedBy: null,
        lockedUntil: null,
        lastError: null,
        finishedAt: null,
      })
      .where(eq(job.id, previous.id)),
  );
  return { id: previous.id, pending: true, armed: true };
}

export async function reenqueueJob(
  store: Db,
  job: NewJob & { jobKey: string },
  payloadFor?: (previous: Job | null) => unknown,
): Promise<{ id: number; pending: boolean }> {
  const { id, pending, armed } = await store.transaction((q) =>
    reenqueueJobSteps(q, job, payloadFor),
  );
  if (armed) emitJobReady(store);
  return { id, pending };
}

export function* getJobSteps(q: Q, id: number) {
  const row = yield* q.one(q.orm.select().from(q.t.job).where(eq(q.t.job.id, id)));
  return row === undefined ? null : mapJob(q, row);
}

export async function getJob(store: Db, id: number): Promise<Job | null> {
  return store.run((q) => getJobSteps(q, id));
}

export function* jobStatusByKeySteps(q: Q, jobKey: string) {
  const { job } = q.t;
  const row = yield* q.one(
    q.orm.select({ status: job.status }).from(job).where(eq(job.jobKey, jobKey)),
  );
  return row?.status ?? null;
}

export async function jobStatusByKey(store: Db, jobKey: string): Promise<string | null> {
  return store.run((q) => jobStatusByKeySteps(q, jobKey));
}

export function* listJobsSteps(q: Q) {
  const rows = yield* q.all(q.orm.select().from(q.t.job).orderBy(q.t.job.id));
  return rows.map((row) => mapJob(q, row));
}

export async function listJobs(store: Db): Promise<Job[]> {
  return store.run(listJobsSteps);
}

export function* nextClaimableRunAtSteps(
  q: Q,
  options: { now?: number; queues?: readonly string[] } = {},
) {
  const { job } = q.t;
  const queues = options.queues;
  if (queues !== undefined && queues.length === 0) return null;
  const now = options.now ?? Date.now();
  const row = yield* q.one(
    q.orm
      .select({ runAt: drizzleSql<number | null>`MIN(${job.runAt})`.mapWith(Number) })
      .from(job)
      .where(
        and(claimable(q, now), queues === undefined ? undefined : inArray(job.queue, [...queues])),
      ),
  );
  return row?.runAt ?? null;
}

/**
 * Earliest `run_at` among rows a claim could take, or null when none exist.
 * This does not claim. The job loop sleeps until this time.
 */
export async function nextClaimableRunAt(
  store: Db,
  options: { now?: number; queues?: readonly string[] } = {},
): Promise<number | null> {
  return store.run((q) => nextClaimableRunAtSteps(q, options));
}

/**
 * One `UPDATE … RETURNING`. Lower priority numbers run first, then earlier run_at.
 * A running row whose lease has expired is reclaimable.
 */
function claimJobQuery(q: Q, options: ClaimOptions) {
  const { job } = q.t;
  const now = options.now ?? Date.now();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const workerId = `${options.workerId ?? "paws"}:${randomUUID()}`;
  return q.orm
    .update(job)
    .set({
      status: "running",
      lockedBy: workerId,
      lockedUntil: now + leaseMs,
      attempts: drizzleSql`${job.attempts} + 1`,
    })
    .where(
      eq(
        job.id,
        drizzleSql`(SELECT candidate.id FROM job AS candidate WHERE ${claimWhere(q, now, options.queues)}
          ORDER BY candidate.priority ASC, candidate.run_at ASC, candidate.id ASC LIMIT 1)`,
      ),
    )
    .returning();
}

export function* claimNextJobSteps(q: Q, options: ClaimOptions = {}) {
  if (options.queues !== undefined && options.queues.length === 0) return null;
  const row = yield* q.one(claimJobQuery(q, options));
  return row === undefined ? null : mapJob(q, row);
}

export async function claimNextJob(store: Db, options: ClaimOptions = {}): Promise<Job | null> {
  return store.run((q) => claimNextJobSteps(q, options));
}

export function* completeJobSteps(q: Q, job: Job, now = Date.now()) {
  if (job.recurringEveryMs !== null) {
    return (
      (yield* updateLeasedSteps(q, job, {
        status: "pending",
        runAt: now + job.recurringEveryMs,
        attempts: 0,
        lockedBy: null,
        lockedUntil: null,
        finishedAt: null,
        lastError: null,
        fireCount: drizzleSql`${q.t.job.fireCount} + 1`,
      })) > 0
    );
  }
  const changed = yield* updateLeasedSteps(q, job, {
    status: "done",
    finishedAt: now,
    lockedBy: null,
    lockedUntil: null,
  });
  if (changed === 0) return false;
  journalOutcome({ ...job, status: "done" });
  return true;
}

/** Succeeds only for the worker that holds the lease. A recurring row arms its next fire. */
export async function completeJob(store: Db, job: Job, now = Date.now()): Promise<boolean> {
  return store.run((q) => completeJobSteps(q, job, now));
}

export function* failJobSteps(
  q: Q,
  job: Job,
  error: unknown,
  options: { now?: number; baseMs?: number; capMs?: number } = {},
) {
  const now = options.now ?? Date.now();
  const message = errorText(error);
  if (job.recurringEveryMs !== null && job.attempts >= job.maxAttempts) {
    const changed = yield* updateLeasedSteps(q, job, {
      status: "pending",
      runAt: now + job.recurringEveryMs,
      attempts: 0,
      lockedBy: null,
      lockedUntil: null,
      finishedAt: null,
      lastError: message,
    });
    return changed > 0 ? yield* getJobSteps(q, job.id) : null;
  }
  if (job.attempts < job.maxAttempts) {
    const delay = Math.max(
      retryBackoffMs(
        job.attempts,
        options.baseMs ?? DEFAULT_BACKOFF_BASE_MS,
        options.capMs ?? DEFAULT_BACKOFF_CAP_MS,
      ),
      retryAfterMs(error) ?? 0,
    );
    const changed = yield* updateLeasedSteps(q, job, {
      status: "pending",
      runAt: now + delay,
      lockedBy: null,
      lockedUntil: null,
      lastError: message,
      itemVersion: itemVersionOf(q, drizzleSql`${q.t.job.payload}`),
    });
    return changed > 0 ? yield* getJobSteps(q, job.id) : null;
  }
  const changed = yield* updateLeasedSteps(q, job, {
    status: "dead",
    finishedAt: now,
    lockedBy: null,
    lockedUntil: null,
    lastError: message,
  });
  if (changed === 0) return null;
  journalOutcome({ ...job, status: "dead", lastError: message });
  return yield* getJobSteps(q, job.id);
}

export async function failJob(
  store: Db,
  job: Job,
  error: unknown,
  options: { now?: number; baseMs?: number; capMs?: number } = {},
): Promise<Job | null> {
  return store.run((q) => failJobSteps(q, job, error, options));
}

export function* isJobCurrentSteps(q: Q, job: Job) {
  const current = yield* getJobSteps(q, job.id);
  return (
    current?.status === "running" &&
    current.lockedBy === job.lockedBy &&
    current.activationId === job.activationId
  );
}

export function* hasLiveJobSteps(q: Q, itemId: string, now: number, exceptJobId?: number) {
  const { job } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: drizzleSql`1` })
      .from(job)
      .where(
        and(
          eq(job.status, "running"),
          gt(job.lockedUntil, now),
          eq(jobItemId(q), itemId),
          ne(job.id, exceptJobId ?? -1),
        ),
      ),
  );
  return row !== undefined;
}

/** Whether a claimed job with an unexpired lease, other than `exceptJobId`, is working on the item. */
export async function hasLiveJob(
  store: Db,
  itemId: string,
  now: number,
  exceptJobId?: number,
): Promise<boolean> {
  return store.run((q) => hasLiveJobSteps(q, itemId, now, exceptJobId));
}

export function* hasOpenItemJobSteps(q: Q, queue: string, itemId: string, exceptJobId?: number) {
  const { job } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: drizzleSql`1` })
      .from(job)
      .where(
        and(
          ...(exceptJobId === undefined ? [] : [ne(job.id, exceptJobId)]),
          eq(job.queue, queue),
          inArray(job.status, ["pending", "running"]),
          eq(jobItemId(q), itemId),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export async function hasOpenItemJob(
  store: Db,
  queue: string,
  itemId: string,
  exceptJobId?: number,
): Promise<boolean> {
  return store.run((q) => hasOpenItemJobSteps(q, queue, itemId, exceptJobId));
}

export function* cancelItemPendingJobsSteps(q: Q, itemId: string, now: number) {
  const { job } = q.t;
  yield* q.exec(
    q.orm
      .update(job)
      .set({ status: "cancelled", finishedAt: now })
      .where(and(eq(job.status, "pending"), eq(jobItemId(q), itemId))),
  );
}

export async function cancelItemPendingJobs(store: Db, itemId: string, now: number): Promise<void> {
  await store.run((q) => cancelItemPendingJobsSteps(q, itemId, now));
}

export function* extendJobLeaseSteps(q: Q, job: Job, now: number, leaseMs: number) {
  return (yield* updateLeasedSteps(q, job, { lockedUntil: now + leaseMs })) > 0;
}

export function extendJobLease(
  store: Db,
  job: Job,
  now: number,
  leaseMs: number,
): Promise<boolean> {
  return store.run((q) => extendJobLeaseSteps(q, job, now, leaseMs));
}

export function* parkLeasedJobSteps(
  q: Q,
  job: Job,
  input: { runAt: number; payload: unknown; attempts: number; now: number },
) {
  const { runAt } = q.t.job;
  const earlier =
    q.dialect === "sqlite"
      ? drizzleSql`MIN(${runAt}, ${input.runAt})`
      : drizzleSql`LEAST(${runAt}, ${input.runAt})`;
  return (
    (yield* updateLeasedSteps(
      q,
      job,
      {
        status: "pending",
        runAt: drizzleSql`CASE WHEN ${runAt} > ${job.runAt} THEN ${earlier} ELSE ${input.runAt} END`,
        attempts: Math.max(0, input.attempts),
        lockedBy: null,
        lockedUntil: null,
        payload: input.payload === undefined ? undefined : payloadValue(q, input.payload),
        itemVersion: itemVersionOf(q, drizzleSql`${q.t.job.payload}`),
      },
      gt(q.t.job.lockedUntil, input.now),
    )) > 0
  );
}

export async function parkLeasedJob(
  store: Db,
  job: Job,
  input: { runAt: number; payload: unknown; attempts: number; now: number },
): Promise<boolean> {
  return store.run((q) => parkLeasedJobSteps(q, job, input));
}

export function* retryLeasedJobSteps(q: Q, job: Job, runAt: number, error: string) {
  return (
    (yield* updateLeasedSteps(q, job, {
      status: "pending",
      runAt,
      lockedBy: null,
      lockedUntil: null,
      lastError: error,
      itemVersion: itemVersionOf(q, drizzleSql`${q.t.job.payload}`),
    })) > 0
  );
}

export async function retryLeasedJob(
  store: Db,
  job: Job,
  runAt: number,
  error: string,
): Promise<boolean> {
  return store.run((q) => retryLeasedJobSteps(q, job, runAt, error));
}

export function* noteJobErrorSteps(q: Q, id: number, message: string) {
  yield* q.exec(q.orm.update(q.t.job).set({ lastError: message }).where(eq(q.t.job.id, id)));
}

export async function noteJobError(store: Db, id: number, message: string): Promise<void> {
  await store.run((q) => noteJobErrorSteps(q, id, message));
}

type CancelOpenJobsInput = {
  reason: string;
  now?: number;
  exceptId?: number;
  itemId?: string;
  mergeLane?: boolean;
};

export function* cancelOpenJobsSteps(q: Q, input: CancelOpenJobsInput) {
  const { job } = q.t;
  const now = input.now ?? Date.now();
  const itemId = input.itemId ?? null;
  const merge = input.mergeLane === true ? 1 : 0;
  const exceptId = input.exceptId ?? null;
  if (itemId === null && merge === 0) return 0;
  const rows = yield* q.all(
    q.orm
      .update(job)
      .set({
        status: "cancelled",
        lastError: input.reason,
        lockedBy: null,
        lockedUntil: null,
        finishedAt: now,
      })
      .where(
        and(
          inArray(job.status, ["pending", "running"]),
          ne(job.queue, "core.command"),
          exceptId === null ? undefined : ne(job.id, exceptId),
          or(
            itemId === null ? undefined : eq(jobItemId(q), itemId),
            merge === 1 ? drizzleSql.raw(mergeLaneSql("job")) : undefined,
          ),
        ),
      )
      .returning(),
  );
  for (const row of rows) journalOutcome(mapJob(q, row));
  return rows.length;
}

/**
 * Cancel open jobs for an item, the global merge lane, or the union of both scopes.
 * `itemId` alone cancels only that item; `mergeLane: true` includes every item's merge work.
 * Cancelling a job does not resolve a remote merge outcome or clear its durable marker.
 * `core.command` rows are left for the drain that is applying the command.
 */
export async function cancelOpenJobs(store: Db, input: CancelOpenJobsInput): Promise<number> {
  return store.run((q) => cancelOpenJobsSteps(q, input));
}

/** Item jobs journal every outcome. Any job that goes dead journals, so none dies unseen. */
function journalOutcome(job: Job): void {
  if (
    job.status !== "dead" &&
    !(EXCLUSIVE_QUEUES as readonly string[]).includes(job.queue) &&
    !isMergeWork(job.queue)
  )
    return;
  const payload = job.payload as { itemId?: unknown } | null;
  const error =
    job.lastError === null ? "" : ` error=${job.lastError.replace(/\s+/g, " ").slice(0, 200)}`;
  journal(
    `job ${job.id} ${job.queue} ${job.status} item=${String(payload?.itemId ?? "-")} attempts=${job.attempts}/${job.maxAttempts}${error}`,
  );
}

function* findByKeySteps(q: Q, jobKey: string) {
  const row = yield* q.one(q.orm.select().from(q.t.job).where(eq(q.t.job.jobKey, jobKey)));
  return row ? mapJob(q, row) : null;
}

function mapJob(q: Q, row: JobRow): Job {
  return {
    id: row.id,
    activationId: row.activationId,
    queue: row.queue,
    jobKey: row.jobKey,
    payload: q.dialect === "sqlite" ? (JSON.parse(row.payload as string) as unknown) : row.payload,
    priority: row.priority,
    runAt: row.runAt,
    status: row.status as JobStatus,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    lockedBy: row.lockedBy,
    lockedUntil: row.lockedUntil,
    lastError: row.lastError,
    createdAt: row.createdAt,
    finishedAt: row.finishedAt,
    recurringEveryMs: row.recurringEveryMs,
    fireCount: row.fireCount,
  };
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function* jobVersionCurrentSteps(q: Q, job: Pick<Job, "id" | "activationId">) {
  const { job: jobTable, workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ expected: jobTable.itemVersion, current: workItem.version })
      .from(jobTable)
      .leftJoin(workItem, eq(workItem.id, jobItemId(q)))
      .where(and(eq(jobTable.id, job.id), eq(jobTable.activationId, job.activationId))),
  );
  return row !== undefined && (row.expected === null || row.expected === row.current);
}

/** The item's version when this job was created, checked before starting side effects. */
export async function jobVersionCurrent(
  store: Db,
  job: Pick<Job, "id" | "activationId">,
): Promise<boolean> {
  return store.run((q) => jobVersionCurrentSteps(q, job));
}

export function* latestItemJobIdSteps(
  q: Q,
  itemId: string,
  queues: readonly string[],
  statuses: readonly string[],
) {
  const { job } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: job.id })
      .from(job)
      .where(
        and(
          inArray(job.status, [...statuses]),
          inArray(job.queue, [...queues]),
          eq(jobItemId(q), itemId),
        ),
      )
      .orderBy(desc(job.id))
      .limit(1),
  );
  return row?.id ?? null;
}

export async function latestItemJobId(
  store: Db,
  itemId: string,
  queues: readonly string[],
  statuses: readonly string[],
): Promise<number | null> {
  return store.run((q) => latestItemJobIdSteps(q, itemId, queues, statuses));
}

export function* itemJobRunningSteps(q: Q, queue: string, itemId: string) {
  const { job } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: drizzleSql`1` })
      .from(job)
      .where(and(eq(job.queue, queue), eq(job.status, "running"), eq(jobItemId(q), itemId)))
      .limit(1),
  );
  return row !== undefined;
}

export async function itemJobRunning(store: Db, queue: string, itemId: string): Promise<boolean> {
  return store.run((q) => itemJobRunningSteps(q, queue, itemId));
}

export function* cancelPendingItemJobsSteps(q: Q, queue: string, itemId: string, now: number) {
  const { job } = q.t;
  yield* q.exec(
    q.orm
      .update(job)
      .set({ status: "cancelled", finishedAt: now })
      .where(and(eq(job.queue, queue), eq(job.status, "pending"), eq(jobItemId(q), itemId))),
  );
}

export async function cancelPendingItemJobs(
  store: Db,
  queue: string,
  itemId: string,
  now: number,
): Promise<void> {
  await store.run((q) => cancelPendingItemJobsSteps(q, queue, itemId, now));
}

export function* cancelAdmittedJobSteps(q: Q, id: number, now: number) {
  const { job } = q.t;
  yield* q.exec(
    q.orm
      .update(job)
      .set({ status: "cancelled", finishedAt: now, lockedBy: null, lockedUntil: null })
      .where(
        and(
          eq(job.id, id),
          or(eq(job.status, "pending"), and(eq(job.status, "running"), lte(job.lockedUntil, now))),
        ),
      ),
  );
}

export async function cancelAdmittedJob(store: Db, id: number, now: number): Promise<void> {
  await store.run((q) => cancelAdmittedJobSteps(q, id, now));
}

export function* runPendingJobNowSteps(q: Q, id: number, now: number) {
  const { job } = q.t;
  yield* q.exec(
    q.orm
      .update(job)
      .set({ runAt: now })
      .where(and(eq(job.id, id), eq(job.status, "pending"), gt(job.runAt, now))),
  );
}

export async function runPendingJobNow(store: Db, id: number, now: number): Promise<void> {
  await store.run((q) => runPendingJobNowSteps(q, id, now));
}

export function* leasedJobsForItemSteps(q: Q, queue: string, itemId: string, now: number) {
  const { job } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ id: job.id, attempts: job.attempts, worker: job.lockedBy })
      .from(job)
      .where(
        and(
          eq(job.queue, queue),
          eq(job.status, "running"),
          eq(jobItemId(q), itemId),
          isNotNull(job.lockedBy),
          gt(job.lockedUntil, now),
        ),
      ),
  );
  return rows as { id: number; attempts: number; worker: string }[];
}

export async function leasedJobsForItem(
  store: Db,
  queue: string,
  itemId: string,
  now: number,
): Promise<{ id: number; attempts: number; worker: string }[]> {
  return store.run((q) => leasedJobsForItemSteps(q, queue, itemId, now));
}

export function* openMemberVmJobSteps(q: Q, queue: string, memberVmId: string) {
  const { job } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: job.id })
      .from(job)
      .where(
        and(
          eq(job.queue, queue),
          inArray(job.status, ["pending", "running"]),
          eq(jsonField(q, job.payload, "memberVmId"), memberVmId),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export async function openMemberVmJob(
  store: Db,
  queue: string,
  memberVmId: string,
): Promise<boolean> {
  return store.run((q) => openMemberVmJobSteps(q, queue, memberVmId));
}

type MemberVmJobCancel = {
  queue: string;
  memberVmId: string;
  statuses: readonly ("pending" | "running")[];
  now: number;
};

export function* cancelMemberVmJobsSteps(q: Q, input: MemberVmJobCancel) {
  const { job } = q.t;
  yield* q.exec(
    q.orm
      .update(job)
      .set({
        status: "cancelled",
        finishedAt: input.now,
        lockedBy: null,
        lockedUntil: null,
        lastError: "member VM deleted",
      })
      .where(
        and(
          eq(job.queue, input.queue),
          inArray(job.status, [...input.statuses]),
          eq(jsonField(q, job.payload, "memberVmId"), input.memberVmId),
        ),
      ),
  );
}

export async function cancelMemberVmJobs(store: Db, input: MemberVmJobCancel): Promise<void> {
  await store.run((q) => cancelMemberVmJobsSteps(q, input));
}

/** Cancel the item's start and resume jobs other than `exceptJobId`, because its work was accepted. */
export function* cancelAcceptedWorkJobsSteps(
  q: Q,
  itemId: string,
  now: number,
  exceptJobId?: number,
) {
  const { job } = q.t;
  yield* q.exec(
    q.orm
      .update(job)
      .set({
        status: "cancelled",
        lastError: "accepted_work",
        lockedBy: null,
        lockedUntil: null,
        finishedAt: now,
      })
      .where(
        and(
          inArray(job.status, ["pending", "running"]),
          inArray(job.queue, [JOB_KIND.start, JOB_KIND.resume]),
          ne(job.id, exceptJobId ?? -1),
          eq(jobItemId(q), itemId),
        ),
      ),
  );
}

export async function cancelAcceptedWorkJobs(
  store: Db,
  itemId: string,
  now: number,
  exceptJobId?: number,
): Promise<void> {
  await store.run((q) => cancelAcceptedWorkJobsSteps(q, itemId, now, exceptJobId));
}

/** The summary on the item's newest merge job. */
export function* latestMergeJobSummarySteps(q: Q, itemId: string) {
  const { job } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ summary: jsonField(q, job.payload, "summary") })
      .from(job)
      .where(and(eq(job.queue, JOB_KIND.merge), eq(jobItemId(q), itemId)))
      .orderBy(desc(job.id))
      .limit(1),
  );
  return row?.summary ?? null;
}

export async function latestMergeJobSummary(store: Db, itemId: string): Promise<string | null> {
  return store.run((q) => latestMergeJobSummarySteps(q, itemId));
}

export function* runningJobIdSteps(q: Q, queue: string, jobKey: string) {
  const { job } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: job.id })
      .from(job)
      .where(and(eq(job.queue, queue), eq(job.jobKey, jobKey), eq(job.status, "running"))),
  );
  return row?.id ?? null;
}

export async function runningJobId(
  store: Db,
  queue: string,
  jobKey: string,
): Promise<number | null> {
  return store.run((q) => runningJobIdSteps(q, queue, jobKey));
}

/** Pending and running merge jobs, each with its payload as JSON text. */
export function* openMergeJobsSteps(q: Q) {
  const { job } = q.t;
  return yield* q.all(
    q.orm
      .select({ id: job.id, activationId: job.activationId, payload: jsonText(q, job.payload) })
      .from(job)
      .where(and(eq(job.queue, JOB_KIND.merge), inArray(job.status, ["pending", "running"]))),
  );
}

export async function openMergeJobs(
  store: Db,
): Promise<{ id: number; activationId: number; payload: string }[]> {
  return store.run((q) => openMergeJobsSteps(q));
}
