import type { Database } from "bun:sqlite";
import { JOB_KIND, TIME_LIMIT_MERGE } from "../core";
import {
  githubDeliveryRecordedSteps,
  openMergeJobsSteps,
  applyWorkItemEventSteps,
  emitJobReady,
  jobVersionCurrentSteps,
  reenqueueJobSteps,
  getWorkItemSteps,
  getConfirmedRemoteMergeSteps,
  nudgeJobRunAtSteps,
  saveCheckpointSteps,
  parkLeasedJob,
  parkLeasedJobSteps,
  recordGitHubDeliverySteps,
  retryLeasedJobSteps,
  returnToMergeQueueSteps,
  sqliteDb,
  type Job,
  type Q,
  type RunnerCapacityWaitState,
  markCloseoutAcceptedSteps,
} from "../db";
import {
  MERGE_CI_ASK_AFTER_MS,
  githubQueueWatch,
  mainMovedSteps,
  type QueueConflictSweep,
} from "../merge";
import { askSteps } from "./operations";
import { prepareCommentDelivery, type PullCommentFilter } from "./pull-comments";
import { recordReviewDeliverySteps } from "./pull-reviews";
import { worktreeBranch } from "./sources";

export const MERGE_OWNER_POLL_MS = 5_000;

export async function waitForMergeTurn(
  db: Database,
  job: Job,
  now: number,
  delayMs = MERGE_OWNER_POLL_MS,
): Promise<"parked" | "lost"> {
  const parked = await sqliteDb(db).run((q) =>
    parkLeasedJobSteps(q, job, {
      runAt: now + delayMs,
      payload: payloadRecord(job.payload),
      attempts: job.attempts - 1,
      now,
    }),
  );
  return parked ? "parked" : "lost";
}

export async function waitForRunnerSlot(
  db: Database,
  job: Job,
  now: number,
  delayMs: number,
  capacityWait: RunnerCapacityWaitState,
): Promise<"parked" | "lost"> {
  return (await parkLeasedJob(sqliteDb(db), job, {
    runAt: now + delayMs,
    payload: { ...payloadRecord(job.payload), capacityWait },
    attempts: job.attempts - 1,
    now,
  }))
    ? "parked"
    : "lost";
}

export async function retryMergeLater(
  db: Database,
  job: Job,
  now: number,
  delayMs: number,
  error: unknown,
): Promise<boolean> {
  return await sqliteDb(db).run((q) =>
    retryLeasedJobSteps(
      q,
      job,
      now + delayMs,
      error instanceof Error ? error.message : String(error),
    ),
  );
}

export async function acceptGitHubDelivery(
  db: Database,
  delivery: { deliveryId: string; event: string; payload: string },
  now: number,
  comments?: PullCommentFilter,
): Promise<boolean> {
  // Avoid provider callbacks for successful duplicates. The transactional insert remains
  // authoritative when another connection accepts this delivery after the read.
  const store = sqliteDb(db);
  if (await store.run((q) => githubDeliveryRecordedSteps(q, delivery.deliveryId))) return false;
  const body: unknown = JSON.parse(delivery.payload);
  // Callbacks can resolve credentials and start an identity-cache refresh. Run them
  // before taking the write lock; only synchronous database effects belong below.
  const wait = comments?.commentWait?.();
  const recordComment = prepareCommentDelivery(delivery.event, body, now, comments);
  const accepted = await store.transaction(function* (q) {
    if (!(yield* recordGitHubDeliverySteps(q, delivery, now))) return null;
    const review = yield* recordReviewDeliverySteps(q, delivery.event, body, now, wait);
    const comment = recordComment ? yield* q.transaction(recordComment) : null;
    const moved = mainMove(delivery.event, body);
    const swept = moved ? yield* mainMovedSteps(q, { ...moved, now }) : false;
    const facts = deliveryFacts(delivery.event, body);
    for (const job of yield* openMergeJobsSteps(q)) {
      const payload = payloadRecord(JSON.parse(job.payload));
      if (!(yield* jobVersionCurrentSteps(q, job))) continue;
      const item =
        typeof payload.itemId === "string" ? yield* getWorkItemSteps(q, payload.itemId) : null;
      const matches =
        delivery.event === "merge_group"
          ? githubQueueWatch(payload)?.queued === true
          : [payload.head, payload.ciWaitHead].some(
              (sha) => typeof sha === "string" && facts.shas.has(sha),
            ) ||
            (item !== null && facts.branches.has(worktreeBranch(item)));
      if (matches) yield* nudgeJobRunAtSteps(q, job.id, now);
    }
    return review.enqueued || comment?.enqueued === true || swept;
  });
  if (accepted === null) return false;
  if (accepted) emitJobReady(store);
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

type VerifiedMerge = {
  itemId: string;
  head: string;
  summary: string;
  now: number;
  reverifyJobId?: number;
};

function* enqueueVerifiedMergeSteps(q: Q, input: VerifiedMerge) {
  const suffix = input.reverifyJobId === undefined ? "" : `:reverify:${input.reverifyJobId}`;
  const jobKey = `merge:${input.itemId}:${input.head}${suffix}`;
  const payload = { itemId: input.itemId, summary: input.summary, head: input.head };
  return yield* q.transaction((tx) =>
    reenqueueJobSteps(tx, { queue: JOB_KIND.merge, jobKey, payload, now: input.now }),
  );
}

export async function enqueueVerifiedMerge(db: Database, input: VerifiedMerge): Promise<number> {
  const store = sqliteDb(db);
  const { id, armed } = await store.transaction((q) => enqueueVerifiedMergeSteps(q, input));
  if (armed) emitJobReady(store);
  return id;
}

export type VerificationOwner = { version: number; runId: string | null };

function* applyCloseoutAcceptanceSteps(q: Q, itemId: string, expected: VerificationOwner) {
  const current = yield* getWorkItemSteps(q, itemId);
  if (
    !current ||
    current.cancelRequested ||
    (yield* getConfirmedRemoteMergeSteps(q, itemId)) !== null ||
    current.version !== expected.version ||
    current.currentRunId !== expected.runId ||
    (current.state !== "verifying" && current.state !== "merge_queue")
  )
    return false;
  if (current.state === "verifying")
    yield* q.transaction((tx) => applyWorkItemEventSteps(tx, current.id, "closeout_accepted"));
  return true;
}

export async function acceptCloseout(
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
): Promise<number | null> {
  const store = sqliteDb(db);
  const accepted = await store.transaction(function* (q) {
    if (!(yield* applyCloseoutAcceptanceSteps(q, input.itemId, input.expected))) return null;
    yield* markCloseoutAcceptedSteps(q, input.itemId, input.head);
    yield* saveCheckpointSteps(q, input.itemId, {
      phase: "merge_queue",
      baseSha: input.base,
      wipCommit: input.head,
    });
    if (input.reverifyJobId === undefined) yield* returnToMergeQueueSteps(q, input.itemId);
    return yield* enqueueVerifiedMergeSteps(q, {
      itemId: input.itemId,
      head: input.head,
      summary: input.summary,
      now: input.now,
      reverifyJobId: input.reverifyJobId,
    });
  });
  if (accepted === null) return null;
  if (accepted.armed) emitJobReady(store);
  return accepted.id;
}

export const SLOW_CI_REASON = "ci_slow";

export async function askAboutSlowCi(
  db: Database,
  itemId: string,
  input: { checks: string; now: number },
): Promise<boolean> {
  // The read and the ask stay in one synchronous pass on SQLite, as before.
  return await sqliteDb(db).transaction(function* (q) {
    const item = yield* getWorkItemSteps(q, itemId);
    if (!item?.sessionKey || item.cancelRequested || item.state !== "merge_queue") return false;
    const hours = Math.round(MERGE_CI_ASK_AFTER_MS / (60 * 60_000));
    yield* askSteps(
      q,
      { itemId, runId: item.currentRunId, sessionId: item.sessionKey, version: item.version },
      "time-limit",
      [
        `GitHub CI is still pending ${hours} hours after it started on the accepted head; merge or stop?`,
        input.checks,
        `The accepted work is on branch \`${item.branchName || worktreeBranch(item)}\`.`,
        `${TIME_LIMIT_MERGE} keeps waiting for CI and merges once it passes, without another agent turn. Stop ends the task without merging: the branch and its pull request stay.`,
      ].join("\n\n"),
      { options: [TIME_LIMIT_MERGE, "Stop"], reason: SLOW_CI_REASON, now: input.now },
    );
    return true;
  });
}
