import type { Database } from "bun:sqlite";
import { and, asc, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { enqueueJobOnce } from "./jobs";
import { orm } from "./orm";
import { job, pullComment, workItemRepository } from "./schema";

/** `review`: a comment-only review. `inline`: one review comment. `conversation`: an issue comment. */
export type PullCommentSource = "review" | "inline" | "conversation";
export type PullCommentOutcome = "restarted" | "asked" | "dropped" | "covered";

export type PullCommentRecord = {
  source: PullCommentSource;
  commentId: number;
  itemId: string;
  pullNumber: number;
  /** The review an inline comment was submitted with; the review's own id for a review. */
  reviewId: number | null;
  author: string | null;
  body: string;
  path: string | null;
  line: number | null;
  receivedAt: number;
  handledAt: number | null;
  outcome: PullCommentOutcome | null;
};

type Row = typeof pullComment.$inferSelect;

/**
 * Quiet time after the last comment or changes-requested review before they go to the agent
 * together, unless `[merge] comment_quiet_seconds` says otherwise.
 */
export const PULL_COMMENT_SETTLE_MS = 60_000;
/**
 * The longest a steady stream of comments and reviews delays the restart, unless
 * `[merge] comment_max_wait_seconds` says otherwise.
 */
export const PULL_COMMENT_MAX_SETTLE_MS = 5 * 60_000;

/** How long comments and reviews are collected: `quietMs` after the latest, `maxMs` at most. */
export type PullFeedbackWait = {
  quietMs: number;
  maxMs: number;
  reviewMaxMs?: number;
};
export const DEFAULT_PULL_FEEDBACK_WAIT: PullFeedbackWait = {
  quietMs: PULL_COMMENT_SETTLE_MS,
  maxMs: PULL_COMMENT_MAX_SETTLE_MS,
};
export const PULL_REVIEW_CHECK_MAX_WAIT_MS = 15 * 60_000;

export type ReviewCheckWait = { head: string; names: string[] };

/**
 * Move the item's pending comment job and changes-requested review jobs to a quiet minute after
 * `receivedAt`, never past five minutes after each job was created. A review and the comments and
 * bot reviews that follow it then reach the agent in one restart. The number of jobs moved.
 */
export function deferPullFeedback(
  db: Database,
  itemId: string,
  receivedAt: number,
  wait: PullFeedbackWait = DEFAULT_PULL_FEEDBACK_WAIT,
): number {
  return orm(db)
    .update(job)
    .set({
      runAt: sql`MIN(MAX(${job.runAt}, ${receivedAt + wait.quietMs}), ${job.createdAt} + ${Math.max(wait.maxMs, wait.quietMs)})`,
    })
    .where(and(eq(job.status, "pending"), pullFeedbackJobs(itemId)))
    .returning({ id: job.id })
    .all().length;
}

/** The item's pending comment job and the jobs of its open reviews. */
function pullFeedbackJobs(itemId: string) {
  return or(
    and(
      eq(job.queue, JOB_KIND.pullComments),
      sql`json_extract(${job.payload}, '$.pullCommentsFor') = ${itemId}`,
    ),
    and(
      eq(job.queue, JOB_KIND.pullReview),
      sql`${job.jobKey} IN (SELECT 'pull-review:' || review_id FROM pull_review
                            WHERE item_id = ${itemId} AND handled_at IS NULL)`,
    ),
  );
}

/**
 * Record a pull request comment once by its source and GitHub id, and make sure one pending job
 * gathers the item's comments. A comment moves that job and the item's pending review jobs to a
 * minute after this comment, so comments and reviews close together become one restart. False when the
 * comment was already recorded. Call inside a transaction.
 */
export function recordPullComment(
  db: Database,
  comment: Omit<PullCommentRecord, "handledAt" | "outcome">,
  wait: PullFeedbackWait = DEFAULT_PULL_FEEDBACK_WAIT,
): boolean {
  const inserted = orm(db)
    .insert(pullComment)
    .values({
      source: comment.source,
      commentId: comment.commentId,
      itemId: comment.itemId,
      pullNumber: comment.pullNumber,
      reviewId: comment.reviewId,
      author: comment.author,
      body: comment.body,
      path: comment.path,
      line: comment.line,
      receivedAt: comment.receivedAt,
    })
    .onConflictDoNothing({ target: [pullComment.source, pullComment.commentId] })
    .returning({ commentId: pullComment.commentId })
    .all();
  if (inserted.length === 0) return false;
  gatherPullFeedback(
    db,
    comment.itemId,
    comment.receivedAt,
    wait,
    `pull-comments:${comment.itemId}:${comment.source}:${comment.commentId}`,
  );
  return true;
}

export function gatherPullFeedback(
  db: Database,
  itemId: string,
  receivedAt: number,
  wait: PullFeedbackWait,
  jobKey: string,
): void {
  deferPullFeedback(db, itemId, receivedAt, wait);
  const gathering = orm(db)
    .select({ n: count() })
    .from(job)
    .where(
      and(
        eq(job.queue, JOB_KIND.pullComments),
        eq(job.status, "pending"),
        sql`json_extract(${job.payload}, '$.pullCommentsFor') = ${itemId}`,
      ),
    )
    .get();
  if ((gathering?.n ?? 0) > 0) return;
  enqueueJobOnce(db, {
    queue: JOB_KIND.pullComments,
    jobKey,
    payload: { pullCommentsFor: itemId },
    runAt: receivedAt + wait.quietMs,
    now: receivedAt,
  });
}

/** This item's comments that have not reached the agent or the team yet, oldest first. */
export function pendingPullComments(db: Database, itemId: string): PullCommentRecord[] {
  return orm(db)
    .select()
    .from(pullComment)
    .where(and(eq(pullComment.itemId, itemId), isNull(pullComment.handledAt)))
    .orderBy(asc(pullComment.receivedAt), asc(pullComment.commentId))
    .all()
    .map(mapRow);
}

export function getPullComment(
  db: Database,
  source: PullCommentSource,
  commentId: number,
): PullCommentRecord | null {
  const row = orm(db)
    .select()
    .from(pullComment)
    .where(and(eq(pullComment.source, source), eq(pullComment.commentId, commentId)))
    .get();
  return row === undefined ? null : mapRow(row);
}

/** Settle the given comments that are still open. The number settled. */
export function settlePullComments(
  db: Database,
  comments: readonly Pick<PullCommentRecord, "source" | "commentId">[],
  outcome: PullCommentOutcome,
  now: number,
): number {
  let settled = 0;
  for (const comment of comments)
    settled += orm(db)
      .update(pullComment)
      .set({ handledAt: now, outcome })
      .where(
        and(
          eq(pullComment.source, comment.source),
          eq(pullComment.commentId, comment.commentId),
          isNull(pullComment.handledAt),
        ),
      )
      .returning({ commentId: pullComment.commentId })
      .all().length;
  return settled;
}

function mapRow(row: Row): PullCommentRecord {
  return {
    source: row.source as PullCommentSource,
    commentId: row.commentId,
    itemId: row.itemId,
    pullNumber: row.pullNumber,
    reviewId: row.reviewId,
    author: row.author,
    body: row.body,
    path: row.path,
    line: row.line,
    receivedAt: row.receivedAt,
    handledAt: row.handledAt,
    outcome: row.outcome as PullCommentOutcome | null,
  };
}

export function commentingApps(db: Database, owner: string, repo: string): string[] {
  return orm(db)
    .selectDistinct({ login: sql<string>`lower(${pullComment.author})` })
    .from(pullComment)
    .innerJoin(workItemRepository, eq(workItemRepository.itemId, pullComment.itemId))
    .where(
      and(
        sql`lower(${workItemRepository.owner}) = lower(${owner})`,
        sql`lower(${workItemRepository.repo}) = lower(${repo})`,
        sql`lower(${pullComment.author}) LIKE '%[bot]'`,
      ),
    )
    .all()
    .map((row) => row.login.slice(0, -"[bot]".length));
}

export function pullReviewCheckWait(db: Database, itemId: string): ReviewCheckWait | null {
  const row = orm(db)
    .select({ wait: sql<string | null>`json_extract(${job.payload}, '$.reviewChecks')` })
    .from(job)
    .where(
      and(
        inArray(job.status, ["pending", "running"]),
        sql`json_extract(${job.payload}, '$.reviewChecks') IS NOT NULL`,
        pullFeedbackJobs(itemId),
      ),
    )
    .orderBy(desc(job.id))
    .limit(1)
    .get();
  if (!row?.wait) return null;
  const wait = JSON.parse(row.wait) as Partial<ReviewCheckWait>;
  return typeof wait.head === "string" && Array.isArray(wait.names)
    ? { head: wait.head, names: wait.names.filter((name) => typeof name === "string") }
    : null;
}
