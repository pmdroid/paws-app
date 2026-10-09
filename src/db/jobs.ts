import type { Database } from "bun:sqlite";
import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  DEFAULT_LEASE_MS,
  retryBackoffMs,
} from "../core";

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

/**
 * One `UPDATE … RETURNING`. Lower priority numbers run first, then earlier run_at.
 * A running row whose lease has expired is reclaimable. No semicolon: one statement.
 */
export function claimJobSql(queueCount: number): string {
  const queueFilter =
    queueCount > 0
      ? ` AND queue IN (${Array.from({ length: queueCount }, () => "?").join(", ")})`
      : "";
  return (
    "UPDATE job SET status = 'running', locked_by = ?, locked_until = ?, attempts = attempts + 1 " +
    "WHERE id = (" +
    "SELECT id FROM job WHERE run_at <= ?" +
    queueFilter +
    " AND (status = 'pending' OR (status = 'running' AND (locked_until IS NULL OR locked_until <= ?))) " +
    "ORDER BY priority ASC, run_at ASC, id ASC LIMIT 1) RETURNING *"
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
  const workerId = options.workerId ?? "paws";
  const sql = claimJobSql(queues?.length ?? 0);
  const binds: (string | number)[] = [workerId, now + leaseMs, now];
  if (queues !== undefined) binds.push(...queues);
  binds.push(now);
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
  return result.changes > 0;
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
    const delay = retryBackoffMs(
      job.attempts,
      options.baseMs ?? DEFAULT_BACKOFF_BASE_MS,
      options.capMs ?? DEFAULT_BACKOFF_CAP_MS,
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
  return result.changes > 0 ? getJob(db, job.id) : null;
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
  const result = db.run(
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
       )`,
    [input.reason, now, exceptId, exceptId, itemId, itemId, merge],
  );
  return result.changes;
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
