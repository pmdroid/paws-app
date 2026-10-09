import type { Database } from "bun:sqlite";
import { NotImplementedError } from "../core";

export const JOB_STATUSES = ["pending", "running", "done", "dead", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type NewJob = {
  queue: string;
  payload?: unknown;
  jobKey?: string;
  priority?: number;
  runAt?: number;
  maxAttempts?: number;
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
};

/** Insert in the same transaction as the state change that needs the work. */
export function enqueueJob(db: Database, job: NewJob): number {
  const now = Date.now();
  const row = db
    .query<{ id: number }, [string, string | null, string, number, number, number, number]>(
      `INSERT INTO job (queue, job_key, payload, priority, run_at, max_attempts, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
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
    );
  if (row === null) {
    throw new Error("enqueueJob did not return an id");
  }
  return row.id;
}

export function getJob(db: Database, id: number): Job | null {
  const row = db.query<JobRow, [number]>("SELECT * FROM job WHERE id = ?").get(id);
  return row === null ? null : mapJob(row);
}

/**
 * QM-09 claims with one `UPDATE … RETURNING` (pending, due, ordered by priority then run_at)
 * and a lease. Expired locks are reclaimed there. This stub fails closed.
 */
export function claimNextJob(db: Database): Job | null {
  void db;
  throw new NotImplementedError("job claim");
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
  };
}
