import type { Database } from "bun:sqlite";
import { JOB_KIND, MERGE_LANE } from "../core";
import {
  applyWorkItemEvent,
  enqueueJobOnce,
  getWorkItem,
  immediate,
  leaveMergeQueue,
  saveCheckpoint,
  type Job,
  type RunnerCapacityWaitState,
} from "../db";

export const MERGE_CI_POLL_MS = 10_000;
export const MERGE_CI_WAIT_MS = 269 * MERGE_CI_POLL_MS;
/** A task waiting in its repository's merge queue, or for a review, checks again this often. */
export const MERGE_QUEUE_POLL_MS = 30_000;
/** GitHub's merge queue batches and tests everyone's pull requests, so a place in it can last hours. */
export const GITHUB_QUEUE_WAIT_MS = 24 * 60 * 60 * 1000;
/** How often a pull request in GitHub's merge queue is read again. */
export const GITHUB_QUEUE_POLL_MS = 30_000;

/** What the last pass saw of the pull request in GitHub's merge queue. Kept in the merge job. */
export type GitHubQueueWatch = {
  /** Paws queued the pull request, or saw it queued, during this merge job. */
  queued: boolean;
  position?: number | null;
  state?: string;
  /** For example "Second in the acme/platform GitHub merge queue, waiting for checks." */
  line?: string;
};

export type CiWaitVerification = {
  base: string;
  head: string;
  summary: string;
};

/** What a parked merge waits for. The Merge queue page reads it from the job payload. */
export type MergeWaitReason = "ahead" | "ci" | "review" | "branch_update";

export function parkMergeForCi(
  db: Database,
  job: Job,
  now: number,
  verified?: Partial<CiWaitVerification>,
  options: {
    queued?: boolean;
    reason?: MergeWaitReason;
    message?: string;
    githubQueue?: GitHubQueueWatch;
  } = {},
): "parked" | "expired" | "lost" {
  const payload = payloadRecord(job.payload);
  if (options.reason)
    payload.mergeWait = {
      reason: options.reason,
      ...(options.message ? { message: options.message } : {}),
      at: now,
    };
  if (options.queued) {
    // Waiting in the queue or for a review has no deadline. The CI wait starts when it moves.
    delete payload.ciWaitDeadline;
    return requeue(db, job, now + MERGE_QUEUE_POLL_MS, payload, now);
  }
  const head = verified?.head;
  const saved = payload.ciWaitDeadline;
  const sameHead = head === undefined || payload.ciWaitHead === head;
  const deadline =
    sameHead && typeof saved === "number" && Number.isFinite(saved)
      ? saved
      : now + (options.githubQueue ? GITHUB_QUEUE_WAIT_MS : MERGE_CI_WAIT_MS);
  if (sameHead && now >= deadline) return "expired";
  return requeue(
    db,
    job,
    now + (options.githubQueue ? GITHUB_QUEUE_POLL_MS : MERGE_CI_POLL_MS),
    {
      ...payload,
      ciWaitDeadline: deadline,
      ...(verified?.base === undefined ? {} : { ciWaitBase: verified.base }),
      ...(verified?.head === undefined ? {} : { ciWaitHead: verified.head }),
      ...(verified?.summary === undefined ? {} : { ciWaitSummary: verified.summary }),
      ...(options.githubQueue === undefined ? {} : { githubQueue: options.githubQueue }),
    },
    now,
  );
}

function requeue(
  db: Database,
  job: Job,
  runAt: number,
  payload: Record<string, unknown>,
  now: number,
  attempts = 0,
): "parked" | "lost" {
  const result = db.run(
    `UPDATE job
     SET status = 'pending',
         run_at = ?,
         attempts = ?,
         locked_by = NULL,
         locked_until = NULL,
         payload = ?
     WHERE id = ? AND status = 'running' AND locked_by = ? AND locked_until > ?`,
    [runAt, Math.max(0, attempts), JSON.stringify(payload), job.id, job.lockedBy, now],
  );
  return result.changes > 0 ? "parked" : "lost";
}

export const MERGE_OWNER_POLL_MS = 5_000;

export function waitForMergeTurn(
  db: Database,
  job: Job,
  now: number,
  delayMs = MERGE_OWNER_POLL_MS,
): "parked" | "lost" {
  return requeue(db, job, now + delayMs, payloadRecord(job.payload), now, job.attempts - 1);
}

export function waitForRunnerSlot(
  db: Database,
  job: Job,
  now: number,
  delayMs: number,
  capacityWait: RunnerCapacityWaitState,
): "parked" | "lost" {
  return requeue(
    db,
    job,
    now + delayMs,
    { ...payloadRecord(job.payload), capacityWait },
    now,
    job.attempts - 1,
  );
}

export function retryMergeLater(
  db: Database,
  job: Job,
  now: number,
  delayMs: number,
  error: unknown,
): boolean {
  const result = db.run(
    `UPDATE job
     SET status = 'pending', run_at = ?, locked_by = NULL, locked_until = NULL, last_error = ?
     WHERE id = ? AND status = 'running' AND locked_by = ?`,
    [now + delayMs, error instanceof Error ? error.message : String(error), job.id, job.lockedBy],
  );
  return result.changes > 0;
}

export function acceptGitHubDelivery(
  _db: Database,
  _delivery: { deliveryId: string; event: string; payload: string },
  _now: number,
): boolean {
  return false;
}

export function ciWaitVerification(payload: unknown): CiWaitVerification | undefined {
  const record = payloadRecord(payload);
  const base = record.ciWaitBase;
  const head = record.ciWaitHead;
  const summary = record.ciWaitSummary;
  if (typeof base !== "string" || base.length === 0) return undefined;
  if (typeof head !== "string" || head.length === 0) return undefined;
  if (typeof summary !== "string") return undefined;
  return { base, head, summary };
}

export function githubQueueWatch(payload: unknown): GitHubQueueWatch | undefined {
  const value = payloadRecord(payload).githubQueue;
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return {
    queued: record.queued === true,
    ...(typeof record.position === "number" || record.position === null
      ? { position: record.position as number | null }
      : {}),
    ...(typeof record.state === "string" ? { state: record.state } : {}),
    ...(typeof record.line === "string" ? { line: record.line } : {}),
  };
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return {};
  return { ...(payload as Record<string, unknown>) };
}

export function enqueueVerifiedMerge(
  db: Database,
  input: { itemId: string; head: string; summary: string; now: number; reverifyJobId?: number },
): number {
  const suffix = input.reverifyJobId === undefined ? "" : `:reverify:${input.reverifyJobId}`;
  const jobKey = `merge:${input.itemId}:${input.head}${suffix}`;
  const payload = { itemId: input.itemId, summary: input.summary, head: input.head };
  db.run(
    `UPDATE job SET status = 'pending', attempts = 0, last_error = NULL, finished_at = NULL,
       locked_by = NULL, locked_until = NULL, run_at = ?, payload = ?
     WHERE job_key = ? AND status IN ('cancelled', 'dead')`,
    [input.now, JSON.stringify(payload), jobKey],
  );
  return enqueueJobOnce(db, {
    queue: JOB_KIND.merge,
    lane: MERGE_LANE,
    jobKey,
    payload,
    now: input.now,
  });
}

export type VerificationOwner = { version: number; runId: string | null };

export function applyCloseoutAcceptance(
  db: Database,
  itemId: string,
  expected: VerificationOwner,
): boolean {
  return immediate(db, () => {
    const current = getWorkItem(db, itemId);
    if (
      !current ||
      current.cancelRequested ||
      current.version !== expected.version ||
      current.currentRunId !== expected.runId ||
      (current.state !== "verifying" && current.state !== "merge_queue")
    )
      return false;
    if (current.state === "verifying") applyWorkItemEvent(db, current.id, "closeout_accepted");
    return true;
  });
}

export function acceptCloseout(
  db: Database,
  input: {
    itemId: string;
    expected: VerificationOwner;
    base: string;
    head: string;
    summary: string;
    now: number;
    reverifyJobId?: number;
  },
): number | null {
  return immediate(db, () => {
    if (!applyCloseoutAcceptance(db, input.itemId, input.expected)) return null;
    saveCheckpoint(db, input.itemId, {
      phase: "merge_queue",
      baseSha: input.base,
      wipCommit: input.head,
    });
    if (input.reverifyJobId === undefined) leaveMergeQueue(db, input.itemId);
    return enqueueVerifiedMerge(db, {
      itemId: input.itemId,
      head: input.head,
      summary: input.summary,
      now: input.now,
      reverifyJobId: input.reverifyJobId,
    });
  });
}
