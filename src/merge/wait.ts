import type { Database } from "bun:sqlite";
export { wakeMergesBehind } from "../db";
import { latestGitHubDelivery, parkLeasedJob, type Job } from "../db";

export const MERGE_CI_POLL_MS = 10_000;
export const MERGE_BACKSTOP_POLL_MS = 5 * 60_000;
export const GITHUB_DELIVERY_QUIET_MS = 60 * 60_000;
export const MERGE_CI_WAIT_MS = 269 * MERGE_CI_POLL_MS;
export const MERGE_CI_ASK_AFTER_MS = 6 * 60 * 60_000;
export const MERGE_QUEUE_POLL_MS = 30_000;
export const GITHUB_QUEUE_WAIT_MS = 24 * 60 * 60 * 1000;
export const GITHUB_QUEUE_POLL_MS = 30_000;
export type GitHubQueueWatch = {
  queued: boolean;
  position?: number | null;
  state?: string;
  line?: string;
};

export type CiWaitVerification = {
  base: string;
  head: string;
  summary: string;
};
export type MergeWaitReason =
  | "ahead"
  | "ci"
  | "review"
  | "branch_update"
  | "dependencies"
  | "merge_outcome"
  | "policy";
export type MergeWait = {
  message: string;
  base?: string;
  head?: string;
  summary?: string;
  queued?: boolean;
  reason: MergeWaitReason;
  githubQueue?: GitHubQueueWatch;
};

export function parkMerge(
  db: Database,
  job: Job,
  now: number,
  wait: Partial<MergeWait> = {},
): "parked" | "expired" | "ask" | "lost" {
  const payload = payloadRecord(job.payload);
  if (wait.reason)
    payload.mergeWait = {
      reason: wait.reason,
      ...(wait.message ? { message: wait.message } : {}),
      at: now,
    };
  if (wait.reason === "merge_outcome") {
    const previous = payload.mergeOutcomeRetries;
    const retries =
      typeof previous === "number" && Number.isFinite(previous)
        ? Math.min(Math.max(previous, 0), 5)
        : 0;
    const delayMs = Math.min(MERGE_CI_POLL_MS * 2 ** retries, MERGE_BACKSTOP_POLL_MS);
    payload.mergeOutcomeRetries = retries + 1;
    return park(db, job, now + delayMs, payload, now);
  }
  delete payload.mergeOutcomeRetries;
  if (wait.queued) {
    delete payload.ciWaitDeadline;
    return park(db, job, now + pollMs(db, now, MERGE_QUEUE_POLL_MS), payload, now);
  }
  const head = wait.head;
  const saved = payload.ciWaitDeadline;
  const sameHead = head === undefined || payload.ciWaitHead === head;
  const resumed = sameHead && typeof saved === "number" && Number.isFinite(saved);
  const deadline = resumed
    ? saved
    : now + (wait.githubQueue ? GITHUB_QUEUE_WAIT_MS : MERGE_CI_WAIT_MS);
  let delayMs = pollMs(db, now, wait.githubQueue ? GITHUB_QUEUE_POLL_MS : MERGE_CI_POLL_MS);
  let started: number | undefined;
  if (wait.githubQueue) {
    if (sameHead && now >= deadline) return "expired";
  } else {
    const savedStart = payload.ciWaitStartedAt;
    started =
      resumed && typeof savedStart === "number" && Number.isFinite(savedStart)
        ? savedStart
        : resumed
          ? deadline - MERGE_CI_WAIT_MS
          : now;
    if (now >= started + MERGE_CI_ASK_AFTER_MS) return "ask";
    if (now >= deadline) delayMs = MERGE_BACKSTOP_POLL_MS;
  }
  return park(
    db,
    job,
    now + delayMs,
    {
      ...payload,
      ciWaitDeadline: deadline,
      ...(started === undefined ? {} : { ciWaitStartedAt: started }),
      ...(wait.base === undefined ? {} : { ciWaitBase: wait.base }),
      ...(wait.head === undefined ? {} : { ciWaitHead: wait.head }),
      ...(wait.summary === undefined ? {} : { ciWaitSummary: wait.summary }),
      ...(wait.githubQueue === undefined ? {} : { githubQueue: wait.githubQueue }),
    },
    now,
  );
}

function pollMs(db: Database, now: number, fastMs: number): number {
  const last = latestGitHubDelivery(db);
  return last !== null && now - last.receivedAt < GITHUB_DELIVERY_QUIET_MS
    ? Math.max(fastMs, MERGE_BACKSTOP_POLL_MS)
    : fastMs;
}

function park(
  db: Database,
  job: Job,
  runAt: number,
  payload: Record<string, unknown>,
  now: number,
): "parked" | "lost" {
  return parkLeasedJob(db, job, { runAt, payload, attempts: 0, now }) ? "parked" : "lost";
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
