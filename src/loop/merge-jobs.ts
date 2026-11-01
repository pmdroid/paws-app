import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  jobVersionCurrent,
  reenqueueJob,
  getWorkItem,
  getConfirmedRemoteMerge,
  immediate,
  saveCheckpoint,
  parkLeasedJob,
  recordGitHubDelivery,
  retryLeasedJob,
  returnToMergeQueue,
  type Job,
  type RunnerCapacityWaitState,
  markCloseoutAccepted,
} from "../db";
import { githubQueueWatch, mainMoved, type QueueConflictSweep } from "../merge";
import { recordCommentDelivery, type PullCommentFilter } from "./pull-comments";
import { recordReviewDelivery } from "./pull-reviews";
import { worktreeBranch } from "./sources";

export const MERGE_OWNER_POLL_MS = 5_000;

export function waitForMergeTurn(
  db: Database,
  job: Job,
  now: number,
  delayMs = MERGE_OWNER_POLL_MS,
): "parked" | "lost" {
  return parkLeasedJob(db, job, {
    runAt: now + delayMs,
    payload: payloadRecord(job.payload),
    attempts: job.attempts - 1,
    now,
  })
    ? "parked"
    : "lost";
}

export function waitForRunnerSlot(
  db: Database,
  job: Job,
  now: number,
  delayMs: number,
  capacityWait: RunnerCapacityWaitState,
): "parked" | "lost" {
  return parkLeasedJob(db, job, {
    runAt: now + delayMs,
    payload: { ...payloadRecord(job.payload), capacityWait },
    attempts: job.attempts - 1,
    now,
  })
    ? "parked"
    : "lost";
}

export function retryMergeLater(
  db: Database,
  job: Job,
  now: number,
  delayMs: number,
  error: unknown,
): boolean {
  return retryLeasedJob(
    db,
    job,
    now + delayMs,
    error instanceof Error ? error.message : String(error),
  );
}

export function acceptGitHubDelivery(
  db: Database,
  delivery: { deliveryId: string; event: string; payload: string },
  now: number,
  comments?: PullCommentFilter,
): boolean {
  if (!recordGitHubDelivery(db, delivery, now)) return false;
  const body: unknown = JSON.parse(delivery.payload);
  recordReviewDelivery(db, delivery.event, body, now, comments?.commentWait?.());
  recordCommentDelivery(db, delivery.event, body, now, comments);
  const moved = mainMove(delivery.event, body);
  if (moved) mainMoved(db, { ...moved, now });
  const facts = deliveryFacts(delivery.event, body);
  const jobs = db
    .query<{ id: number; activationId: number; payload: string }, [string]>(
      "SELECT id, activation_id AS activationId, payload FROM job WHERE queue = ? AND status IN ('pending', 'running')",
    )
    .all(JOB_KIND.merge);
  for (const job of jobs) {
    const payload = payloadRecord(JSON.parse(job.payload));
    if (!jobVersionCurrent(db, job)) continue;
    const item = typeof payload.itemId === "string" ? getWorkItem(db, payload.itemId) : null;
    const matches =
      delivery.event === "merge_group"
        ? githubQueueWatch(payload)?.queued === true
        : [payload.head, payload.ciWaitHead].some(
            (sha) => typeof sha === "string" && facts.shas.has(sha),
          ) ||
          (item !== null && facts.branches.has(worktreeBranch(item)));
    if (matches)
      db.run(
        `UPDATE job SET run_at = CASE WHEN status = 'running' THEN MAX(run_at, ?) ELSE MIN(run_at, ?) END
         WHERE id = ?`,
        [now, now, job.id],
      );
  }
  return true;
}

/** A push to the default branch, or a pull request merged into it: main's new commit. */
function mainMove(event: string, body: unknown): QueueConflictSweep | null {
  const record = payloadRecord(body);
  const repository = payloadRecord(record.repository);
  const name = repository.full_name;
  const main = repository.default_branch;
  if (typeof name !== "string" || typeof main !== "string") return null;
  if (event === "push" && record.ref === `refs/heads/${main}` && record.deleted !== true)
    return { repository: name, main: typeof record.after === "string" ? record.after : null };
  const pull = payloadRecord(record.pull_request);
  if (
    event === "pull_request" &&
    record.action === "closed" &&
    pull.merged === true &&
    payloadRecord(pull.base).ref === main
  )
    return {
      repository: name,
      main: typeof pull.merge_commit_sha === "string" ? pull.merge_commit_sha : null,
    };
  return null;
}

function deliveryFacts(event: string, body: unknown): { shas: Set<string>; branches: Set<string> } {
  const record = payloadRecord(body);
  const field = (value: unknown, ...keys: string[]): unknown =>
    keys.reduce((current, key) => payloadRecord(current)[key], value);
  const shas: unknown[] = [];
  const branches: unknown[] = [];
  if (
    ((event === "check_suite" || event === "check_run") && record.action !== "completed") ||
    (event === "status" && record.state === "pending")
  )
    return { shas: new Set(), branches: new Set() };
  if (event === "check_suite") {
    shas.push(field(record, "check_suite", "head_sha"));
    branches.push(field(record, "check_suite", "head_branch"));
  } else if (event === "check_run") {
    shas.push(field(record, "check_run", "head_sha"));
    branches.push(field(record, "check_run", "check_suite", "head_branch"));
  } else if (event === "status") {
    shas.push(record.sha);
    if (Array.isArray(record.branches))
      branches.push(...record.branches.map((branch) => field(branch, "name")));
  } else if (
    event === "pull_request" ||
    event === "pull_request_review" ||
    event === "pull_request_review_comment"
  ) {
    shas.push(field(record, "pull_request", "head", "sha"));
    branches.push(field(record, "pull_request", "head", "ref"));
  }
  const strings = (values: unknown[]) =>
    new Set(values.filter((value): value is string => typeof value === "string"));
  return { shas: strings(shas), branches: strings(branches) };
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
  return reenqueueJob(db, {
    queue: JOB_KIND.merge,
    jobKey,
    payload,
    now: input.now,
  }).id;
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
      getConfirmedRemoteMerge(db, itemId) !== null ||
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
    markCloseoutAccepted(db, input.itemId, input.head);
    saveCheckpoint(db, input.itemId, {
      phase: "merge_queue",
      baseSha: input.base,
      wipCommit: input.head,
    });
    if (input.reverifyJobId === undefined) returnToMergeQueue(db, input.itemId);
    return enqueueVerifiedMerge(db, {
      itemId: input.itemId,
      head: input.head,
      summary: input.summary,
      now: input.now,
      reverifyJobId: input.reverifyJobId,
    });
  });
}
