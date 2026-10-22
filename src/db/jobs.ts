import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  DEFAULT_LEASE_MS,
  IN_FLIGHT_ITEM_STATES,
  isMergeWork,
  JOB_KIND,
  MERGE_LANE,
  retryAfterMs,
  retryBackoffMs,
} from "../core";
import { journal } from "./journal";

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
  lane?: string;
  /** Clock injection for tests. Defaults to Date.now(). */
  now?: number;
};

export type Job = {
  id: number;
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
  lane: string;
};

type JobRow = {
  id: number;
  queue: string;
  job_key: string | null;
  payload: string;
  priority: number;
  run_at: number;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_until: number | null;
  last_error: string | null;
  created_at: number;
  finished_at: number | null;
  recurring_every_ms: number | null;
  fire_count: number;
  lane: string;
};

export type ClaimOptions = {
  workerId?: string;
  leaseMs?: number;
  now?: number;
  /** When set, only these queues are eligible. An empty list claims nothing. */
  queues?: readonly string[];
};

const EXCLUSIVE_QUEUES = [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify] as const;

function sqlLiteral(value: string): string {
  if (!/^[A-Za-z0-9._%:-]+$/.test(value)) throw new Error(`unsafe SQL literal: ${value}`);
  return `'${value}'`;
}

function mergeLaneSql(alias: string): string {
  return `(${alias}.queue = ${sqlLiteral(JOB_KIND.merge)} OR ${alias}.queue LIKE ${sqlLiteral(`${JOB_KIND.merge}.%`)} OR ${alias}.lane = ${sqlLiteral(MERGE_LANE)} OR ${alias}.lane LIKE ${sqlLiteral(`${MERGE_LANE}:%`)})`;
}

/** Item execution. A second one stays pending until the first item is finished. */
const EXCLUSIVE_SQL = `(candidate.queue IN (${EXCLUSIVE_QUEUES.map(sqlLiteral).join(", ")}))`;

const IN_FLIGHT_SQL = IN_FLIGHT_ITEM_STATES.map(sqlLiteral).join(", ");

/**
 * One `UPDATE … RETURNING`. Lower priority numbers run first, then earlier run_at.
 * A running row whose lease has expired is reclaimable. No semicolon: one statement.
 *
 * `item.start`, `run.resume`, `run.reverify`, and `github.merge` are exclusive.
 * A ready item is not claimed while another item is in flight or while one of
 * those jobs still holds a lease. The in-flight item can still resume, reverify,
 * and merge. Other queues, including `core.command` and `linear.catchup`, are not held up.
 */
export function claimJobSql(queueCount: number): string {
  const queueFilter =
    queueCount > 0
      ? ` AND candidate.queue IN (${Array.from({ length: queueCount }, () => "?").join(", ")})`
      : "";
  const itemId = "COALESCE(json_extract(candidate.payload, '$.itemId'), '')";
  const heldExclusive = EXCLUSIVE_SQL.replaceAll("candidate.", "held.");
  const reservation = `EXISTS (SELECT 1 FROM scheduler_admission a WHERE a.item_id = ${itemId}
    AND (candidate.queue != ${sqlLiteral(JOB_KIND.start)} OR a.job_id = candidate.id))`;
  const parallel = `(candidate.queue != ${sqlLiteral(JOB_KIND.start)} OR EXISTS
    (SELECT 1 FROM work_item mine WHERE mine.id = ${itemId} AND mine.state = 'queued' AND mine.cancel_requested = 0
      AND NOT EXISTS (SELECT 1 FROM run live WHERE live.item_id=mine.id AND live.status IN ('active','provisioning'))))
    AND candidate.queue IN (${[JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify].map(sqlLiteral).join(",")})
    AND ${reservation}`;
  const sameItem = `EXISTS (SELECT 1 FROM job held WHERE held.id != candidate.id AND held.status = 'running'
    AND (held.locked_until IS NULL OR held.locked_until > ?) AND (${heldExclusive} OR ${mergeLaneSql("held")})
    AND COALESCE(json_extract(held.payload,'$.itemId'),'') = ${itemId})`;
  const holdsExecution = `(other.state != 'merge_queue'
    OR EXISTS (SELECT 1 FROM run live WHERE live.item_id=other.id AND live.status IN ('active','provisioning'))
    OR EXISTS (SELECT 1 FROM job held WHERE held.status='running'
      AND (held.locked_until IS NULL OR held.locked_until>?) AND ${heldExclusive}
      AND json_extract(held.payload,'$.itemId')=other.id))`;
  const unreserved = `EXISTS (SELECT 1 FROM work_item other WHERE other.state IN (${IN_FLIGHT_SQL})
      AND other.id != ${itemId} AND ${holdsExecution} AND NOT EXISTS (SELECT 1 FROM scheduler_admission a WHERE a.item_id = other.id))
    OR EXISTS (SELECT 1 FROM job held WHERE held.id != candidate.id AND held.status = 'running'
      AND (held.locked_until IS NULL OR held.locked_until > ?) AND ${heldExclusive}
      AND NOT EXISTS (SELECT 1 FROM scheduler_admission a WHERE a.item_id = json_extract(held.payload,'$.itemId')))`;
  const reposDiffer = `EXISTS (SELECT 1 FROM work_item_repository mine
    JOIN work_item_repository other ON other.item_id = COALESCE(json_extract(held.payload,'$.itemId'),'')
    WHERE mine.item_id = ${itemId}
      AND (lower(mine.owner) != lower(other.owner) OR lower(mine.repo) != lower(other.repo)))`;
  const heldSameMergeLane = `EXISTS (SELECT 1 FROM job held WHERE held.id != candidate.id AND held.status = 'running'
    AND (held.locked_until IS NULL OR held.locked_until > ?) AND ${mergeLaneSql("held")} AND NOT (${reposDiffer}))`;
  return (
    "UPDATE job SET status = 'running', locked_by = ?, locked_until = ?, attempts = attempts + 1 " +
    "WHERE id = (" +
    "SELECT candidate.id FROM job AS candidate WHERE candidate.run_at <= ?" +
    queueFilter +
    ` AND NOT (candidate.queue = ${sqlLiteral(JOB_KIND.start)} AND ${reservation} AND NOT EXISTS
      (SELECT 1 FROM work_item mine WHERE mine.id = ${itemId} AND mine.state = 'queued' AND mine.cancel_requested = 0
      AND NOT EXISTS (SELECT 1 FROM run live WHERE live.item_id=mine.id AND live.status IN ('active','provisioning'))))` +
    " AND (candidate.status = 'pending' OR (candidate.status = 'running' AND (candidate.locked_until IS NULL OR candidate.locked_until <= ?))) " +
    `AND NOT (${EXCLUSIVE_SQL} AND NOT (${parallel}) AND (` +
    "EXISTS (SELECT 1 FROM job AS held WHERE held.id != candidate.id AND held.status = 'running' " +
    `AND (held.locked_until IS NULL OR held.locked_until > ?) AND (${heldExclusive} OR (${mergeLaneSql("held")} AND COALESCE(json_extract(held.payload,'$.itemId'),'') = ${itemId}))) ` +
    `OR (candidate.queue = ${sqlLiteral(JOB_KIND.start)} AND EXISTS (SELECT 1 FROM work_item AS active WHERE active.state IN (${IN_FLIGHT_SQL}))) ` +
    `OR (EXISTS (SELECT 1 FROM work_item AS other WHERE other.state IN (${IN_FLIGHT_SQL}) AND other.id != ${itemId}) ` +
    `AND NOT EXISTS (SELECT 1 FROM work_item AS mine WHERE mine.state IN (${IN_FLIGHT_SQL}) AND mine.id = ${itemId}))` +
    `)) AND NOT (${mergeLaneSql("candidate")} AND ${heldSameMergeLane}) ` +
    `AND NOT ((${parallel}) AND (${sameItem} OR ${unreserved})) ` +
    "ORDER BY candidate.priority ASC, candidate.run_at ASC, candidate.id ASC LIMIT 1) RETURNING *"
  );
}

/** Insert in the same transaction as the state change that needs the work. */
export function enqueueJob(db: Database, job: NewJob): number {
  const now = job.now ?? Date.now();
  const row = db
    .query<
      { id: number },
      [string, string | null, string, number, number, number, number, number | null, string]
    >(
      `INSERT INTO job (
         queue, job_key, payload, priority, run_at, max_attempts, created_at, recurring_every_ms, lane
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      job.queue,
      job.jobKey ?? null,
      JSON.stringify(job.payload ?? {}),
      job.priority ?? 5,
      job.runAt ?? now,
      job.maxAttempts ?? 10,
      now,
      job.recurringEveryMs ?? null,
      job.lane ?? "default",
    );
  if (row === null) {
    throw new Error("enqueueJob did not return an id");
  }
  return row.id;
}

/**
 * Return the open row for this key when one exists. A finished key cannot be
 * inserted again (`job_key` is unique for the life of the table), so the
 * existing id is returned and the caller keeps the original row.
 */
export function enqueueJobOnce(db: Database, job: NewJob): number {
  if (job.jobKey !== undefined) {
    const existing = findByKey(db, job.jobKey);
    if (existing) return existing.id;
  }
  try {
    return enqueueJob(db, job);
  } catch (error) {
    if (job.jobKey !== undefined && isUnique(error)) {
      const existing = findByKey(db, job.jobKey);
      if (existing) return existing.id;
    }
    throw error;
  }
}

export function getJob(db: Database, id: number): Job | null {
  const row = db.query<JobRow, [number]>("SELECT * FROM job WHERE id = ?").get(id);
  return row === null ? null : mapJob(row);
}

export function listJobs(db: Database): Job[] {
  return db.query<JobRow, []>("SELECT * FROM job ORDER BY id").all().map(mapJob);
}

export function claimNextJob(db: Database, options: ClaimOptions = {}): Job | null {
  const queues = options.queues;
  if (queues !== undefined && queues.length === 0) return null;
  const now = options.now ?? Date.now();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const workerId = `${options.workerId ?? "paws"}:${randomUUID()}`;
  const sql = claimJobSql(queues?.length ?? 0);
  const binds: (string | number)[] = [workerId, now + leaseMs, now];
  if (queues !== undefined) binds.push(...queues);
  // Reclaim threshold, then the cutoff for a lease that still blocks a second item.
  binds.push(now, now, now, now, now, now);
  const row = db.query<JobRow, Array<string | number>>(sql).get(...binds);
  return row === null ? null : mapJob(row);
}

/** Succeeds only for the worker that holds the lease. A recurring row arms its next fire. */
export function completeJob(db: Database, job: Job, now = Date.now()): boolean {
  if (job.recurringEveryMs !== null) {
    const result = db.run(
      `UPDATE job
       SET status = 'pending',
           run_at = ?,
           attempts = 0,
           locked_by = NULL,
           locked_until = NULL,
           finished_at = NULL,
           last_error = NULL,
           fire_count = fire_count + 1
       WHERE id = ? AND status = 'running' AND locked_by = ?`,
      [now + job.recurringEveryMs, job.id, job.lockedBy],
    );
    return result.changes > 0;
  }
  const result = db.run(
    `UPDATE job
     SET status = 'done', finished_at = ?, locked_by = NULL, locked_until = NULL
     WHERE id = ? AND status = 'running' AND locked_by = ?`,
    [now, job.id, job.lockedBy],
  );
  if (result.changes === 0) return false;
  journalOutcome({ ...job, status: "done" });
  return true;
}

export function failJob(
  db: Database,
  job: Job,
  error: unknown,
  options: { now?: number; baseMs?: number; capMs?: number } = {},
): Job | null {
  const now = options.now ?? Date.now();
  const message = errorText(error);
  if (job.recurringEveryMs !== null && job.attempts >= job.maxAttempts) {
    const result = db.run(
      `UPDATE job
       SET status = 'pending',
           run_at = ?,
           attempts = 0,
           locked_by = NULL,
           locked_until = NULL,
           finished_at = NULL,
           last_error = ?
       WHERE id = ? AND status = 'running' AND locked_by = ?`,
      [now + job.recurringEveryMs, message, job.id, job.lockedBy],
    );
    return result.changes > 0 ? getJob(db, job.id) : null;
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
    const result = db.run(
      `UPDATE job
       SET status = 'pending', run_at = ?, locked_by = NULL, locked_until = NULL, last_error = ?
       WHERE id = ? AND status = 'running' AND locked_by = ?`,
      [now + delay, message, job.id, job.lockedBy],
    );
    return result.changes > 0 ? getJob(db, job.id) : null;
  }
  const result = db.run(
    `UPDATE job
     SET status = 'dead', finished_at = ?, locked_by = NULL, locked_until = NULL, last_error = ?
     WHERE id = ? AND status = 'running' AND locked_by = ?`,
    [now, message, job.id, job.lockedBy],
  );
  if (result.changes === 0) return null;
  journalOutcome({ ...job, status: "dead", lastError: message });
  return getJob(db, job.id);
}

export function isJobCurrent(db: Database, job: Job): boolean {
  const current = getJob(db, job.id);
  return current?.status === "running" && current.lockedBy === job.lockedBy;
}

export function extendJobLease(db: Database, job: Job, now: number, leaseMs: number): boolean {
  const result = db.run(
    `UPDATE job SET locked_until = ? WHERE id = ? AND status = 'running' AND locked_by = ?`,
    [now + leaseMs, job.id, job.lockedBy],
  );
  return result.changes > 0;
}

export function noteJobError(db: Database, id: number, message: string): void {
  db.run("UPDATE job SET last_error = ? WHERE id = ?", [message, id]);
}

/**
 * Cancel open work so a leased merge cannot complete after stop, sleep, or restart.
 * `core.command` rows are left for the drain that is applying the command.
 */
export function cancelOpenJobs(
  db: Database,
  input: {
    reason: string;
    now?: number;
    exceptId?: number;
    itemId?: string;
    mergeLane?: boolean;
  },
): number {
  const now = input.now ?? Date.now();
  const itemId = input.itemId ?? null;
  const merge = input.mergeLane === true ? 1 : 0;
  const exceptId = input.exceptId ?? null;
  if (itemId === null && merge === 0) return 0;
  const rows = db
    .query<JobRow, Array<string | number | null>>(
      `UPDATE job
     SET status = 'cancelled',
         last_error = ?,
         locked_by = NULL,
         locked_until = NULL,
         finished_at = ?
     WHERE status IN ('pending', 'running')
       AND queue != 'core.command'
       AND (? IS NULL OR id != ?)
       AND (
         (? IS NOT NULL AND json_extract(payload, '$.itemId') = ?)
         OR (? = 1 AND (queue = 'github.merge' OR lane = 'merge' OR queue LIKE 'github.merge.%'))
       )
     RETURNING *`,
    )
    .all(input.reason, now, exceptId, exceptId, itemId, itemId, merge);
  for (const row of rows) journalOutcome(mapJob(row));
  return rows.length;
}

function journalOutcome(job: Job): void {
  if (
    !(EXCLUSIVE_QUEUES as readonly string[]).includes(job.queue) &&
    !isMergeWork(job.queue, job.lane)
  )
    return;
  const payload = job.payload as { itemId?: unknown } | null;
  const error =
    job.lastError === null ? "" : ` error=${job.lastError.replace(/\s+/g, " ").slice(0, 200)}`;
  journal(
    `job ${job.id} ${job.queue} ${job.status} item=${String(payload?.itemId ?? "-")} attempts=${job.attempts}/${job.maxAttempts}${error}`,
  );
}

function findByKey(db: Database, jobKey: string): { id: number } | null {
  return db.query<{ id: number }, [string]>("SELECT id FROM job WHERE job_key = ?").get(jobKey);
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    queue: row.queue,
    jobKey: row.job_key,
    payload: JSON.parse(row.payload) as unknown,
    priority: row.priority,
    runAt: row.run_at,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    lockedBy: row.locked_by,
    lockedUntil: row.locked_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    recurringEveryMs: row.recurring_every_ms,
    fireCount: row.fire_count,
    lane: row.lane,
  };
}

function isUnique(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  return code.includes("CONSTRAINT") || error.message.includes("UNIQUE");
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
