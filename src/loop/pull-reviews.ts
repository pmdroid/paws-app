import type { Database } from "bun:sqlite";
import {
  fixRounds,
  getPullReview,
  getItemPullRequest,
  getWorkItem,
  immediate,
  recordPullReview,
  settlePullReview,
  type PullReviewRecord,
  type PullReviewState,
  type WorkItemRecord,
} from "../db";
import type { LeaveMergeQueueResult, ReviewThread } from "../github";
import { ask, restart } from "./operations";
import { worktreeBranch } from "./sources";

/** How often a review waiting for a live turn, evaluation or merge attempt looks again. */
export const PULL_REVIEW_POLL_MS = 15_000;

const ENDED = new Set(["cancelled", "merged", "completed", "failed", "manual"]);
const COMMENT_CHARS = 2_000;
const DIGEST_CHARS = 12_000;

export const REVIEW_FIX_INSTRUCTION =
  "Fix what you are confident about. Before changing anything you are unsure of, ask the team with ask_team in this session and wait for the answer. Commit the fixes on this branch. Leave the review threads for the reviewer to resolve.";

/**
 * Record a submitted changes-requested `pull_request_review` webhook for the item that owns the
 * pull request's branch, once per review id. Comment-only reviews are comments
 * (`recordCommentDelivery`); approvals and dismissals only wake the merge job. True when this
 * delivery recorded a new review.
 */
export function recordReviewDelivery(
  db: Database,
  event: string,
  body: unknown,
  now: number,
): boolean {
  if (event !== "pull_request_review") return false;
  const payload = record(body);
  const review = record(payload.review);
  const pull = record(payload.pull_request);
  const head = record(pull.head);
  const state = typeof review.state === "string" ? review.state.toLowerCase() : "";
  if (payload.action !== "submitted" || state !== "changes_requested") return false;
  const reviewId = review.id;
  const pullNumber = pull.number;
  const branch = head.ref;
  const repository = record(payload.repository);
  const owner = record(repository.owner).login;
  const repo = repository.name;
  const headRepository = record(head.repo);
  if (
    typeof reviewId !== "number" ||
    typeof pullNumber !== "number" ||
    typeof branch !== "string" ||
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    // Paws pushes its branch to the base repository. A fork's pull request can reuse the branch
    // name, so the head must live in the same repository.
    typeof headRepository.id !== "number" ||
    headRepository.id !== repository.id
  )
    return false;
  return immediate(db, () => {
    const item = itemForBranch(db, owner, repo, branch);
    if (item === null) return false;
    const opened = getItemPullRequest(db, item.id);
    if (opened !== null && opened.pullNumber !== pullNumber) return false;
    return recordPullReview(db, {
      reviewId,
      itemId: item.id,
      state: state as PullReviewState,
      pullNumber,
      head: typeof review.commit_id === "string" ? review.commit_id : null,
      reviewer:
        typeof record(review.user).login === "string" ? String(record(review.user).login) : null,
      body: typeof review.body === "string" ? review.body : "",
      receivedAt: now,
    });
  });
}

/** The ongoing item whose branch in `owner/repo` is `branch`. */
export function itemForBranch(
  db: Database,
  owner: string,
  repo: string,
  branch: string,
): WorkItemRecord | null {
  const ids = db
    .query<{ id: string }, [string, string]>(
      `SELECT i.id FROM work_item i JOIN work_item_repository r ON r.item_id = i.id
       WHERE lower(r.owner) = lower(?) AND lower(r.repo) = lower(?)
         AND i.state NOT IN ('cancelled','merged','completed','failed','manual')
       ORDER BY i.created_at DESC`,
    )
    .all(owner, repo);
  for (const { id } of ids) {
    const item = getWorkItem(db, id);
    if (item && (item.branchName || worktreeBranch(item)) === branch) return item;
  }
  return null;
}

export type PullReviewCapabilities = {
  now(): number;
  /** A turn, evaluation or merge attempt of this item is running in this process. */
  busy(item: WorkItemRecord): boolean;
  /**
   * Take the pull request out of GitHub's merge queue, so GitHub cannot merge the reviewed head
   * while Paws waits. Throws when GitHub cannot be read.
   */
  leaveMergeQueue(item: WorkItemRecord, pullNumber: number): Promise<LeaveMergeQueueResult>;
  /** Unresolved review threads on the pull request. Throws when GitHub cannot be read. */
  threads(item: WorkItemRecord, pullNumber: number): Promise<ReviewThread[]>;
  fixRoundLimit(item: WorkItemRecord): number;
  session(item: WorkItemRecord): string | null;
  flush(): Promise<void>;
};

export type PullReviewStep = "wait" | "restarted" | "asked" | "dropped" | "done";

/**
 * Act on one recorded review. A changes-requested review waits until the item rests in the merge
 * queue with nothing running, then restarts it with the review and its unresolved threads, or asks
 * the team when the fix rounds are spent.
 */
export async function handlePullReview(
  db: Database,
  reviewId: number,
  caps: PullReviewCapabilities,
): Promise<PullReviewStep> {
  const review = getPullReview(db, reviewId);
  if (review === null || review.handledAt !== null) return "done";
  const item = getWorkItem(db, review.itemId);
  if (item === null || ENDED.has(item.state) || item.cancelRequested) {
    settlePullReview(db, reviewId, "dropped", caps.now());
    return "dropped";
  }
  if (review.state === "commented") {
    // Recorded before comment-only reviews became comments; `recordCommentDelivery` has them now.
    settlePullReview(db, reviewId, "dropped", caps.now());
    return "dropped";
  }
  if (item.state === "merge_queue") {
    // Before waiting on anything: GitHub's own merge queue does not wait for Paws.
    const queue = await caps.leaveMergeQueue(item, review.pullNumber);
    if (queue === "merged" || queue === "closed") {
      settlePullReview(db, reviewId, "dropped", caps.now());
      return "dropped";
    }
  }
  if (item.state !== "merge_queue" || caps.busy(item)) return "wait";
  const threads = await caps.threads(item, review.pullNumber);
  const step = immediate(db, (): PullReviewStep => {
    const current = getWorkItem(db, item.id);
    if (current === null || current.version !== item.version || current.state !== "merge_queue")
      return "wait";
    const rounds = fixRounds(db, current.id);
    const limit = caps.fixRoundLimit(current);
    const digest = reviewDigest(review, threads);
    if (rounds < limit) {
      const jobId = restart(db, current, {
        reason: "review",
        body: `${digest}\n\n${REVIEW_FIX_INSTRUCTION}`,
        jobKey: `review:${current.id}:${review.reviewId}`,
        now: caps.now(),
      });
      if (jobId === null) return "wait";
      settlePullReview(db, reviewId, "restarted", caps.now());
      return "restarted";
    }
    const sessionId = caps.session(current);
    if (sessionId === null) {
      settlePullReview(db, reviewId, "dropped", caps.now());
      return "dropped";
    }
    ask(
      db,
      {
        itemId: current.id,
        runId: current.currentRunId,
        sessionId,
        version: current.version,
      },
      "ci-help",
      `${reviewer(review)} requested changes on pull request #${review.pullNumber}, and all ${limit} fix rounds are spent. Reply with guidance and Paws hands it to the agent with the review, or stop the task.\n\n${digest}`,
      { reason: "budget_spent", now: caps.now() },
    );
    settlePullReview(db, reviewId, "asked", caps.now());
    return "asked";
  });
  if (step !== "wait") await caps.flush();
  return step;
}

/** The review body and its unresolved threads, as the agent and the team read them. */
export function reviewDigest(review: PullReviewRecord, threads: readonly ReviewThread[]): string {
  const lines = [`${reviewer(review)} requested changes on pull request #${review.pullNumber}.`];
  if (review.body.trim() !== "") lines.push("", "Review:", clip(review.body.trim()));
  if (threads.length > 0) {
    lines.push("", "Unresolved review threads:");
    threads.forEach((thread, index) => lines.push(threadLines(thread, index + 1)));
  }
  return clip(lines.join("\n"), DIGEST_CHARS);
}

export function threadLines(thread: ReviewThread, index: number): string {
  const where = thread.path
    ? `\`${thread.path}${thread.line === null ? "" : `:${thread.line}`}\``
    : "general";
  const header = `${index}. ${where}${thread.outdated ? " (outdated)" : ""}`;
  const comments = thread.comments.map(
    (comment) =>
      `   ${comment.author ? `@${comment.author}` : "Someone"}: ${clip(comment.body.trim()).replaceAll("\n", "\n   ")}`,
  );
  return [header, ...comments].join("\n");
}

function reviewer(review: PullReviewRecord): string {
  return review.reviewer ? `@${review.reviewer}` : "A reviewer";
}

export function clip(text: string, chars = COMMENT_CHARS): string {
  return text.length <= chars ? text : `${text.slice(0, chars - 1)}…`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
