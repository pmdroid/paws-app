import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { enqueueJobOnce } from "./jobs";
import { orm } from "./orm";
import {
  DEFAULT_PULL_FEEDBACK_WAIT,
  deferPullFeedback,
  type PullFeedbackWait,
} from "./pull-comments";
import { job, pullReview } from "./schema";

export type PullReviewState = "changes_requested" | "commented";
export type PullReviewOutcome = "restarted" | "asked" | "posted" | "dropped";

export type PullReviewRecord = {
  reviewId: number;
  itemId: string;
  state: PullReviewState;
  pullNumber: number;
  head: string | null;
  reviewer: string | null;
  body: string;
  receivedAt: number;
  handledAt: number | null;
  outcome: PullReviewOutcome | null;
};

type Row = typeof pullReview.$inferSelect;

export function pullReviewJobKey(reviewId: number): string {
  return `pull-review:${reviewId}`;
}

/**
 * Record a submitted review once by its GitHub id and enqueue the job that acts on it a quiet
 * minute later. False when the id was already recorded, so a redelivered webhook does nothing.
 * Call inside a transaction.
 */
export function recordPullReview(
  db: Database,
  review: Omit<PullReviewRecord, "handledAt" | "outcome">,
  wait: PullFeedbackWait = DEFAULT_PULL_FEEDBACK_WAIT,
): boolean {
  const inserted = orm(db)
    .insert(pullReview)
    .values({
      reviewId: review.reviewId,
      itemId: review.itemId,
      state: review.state,
      pullNumber: review.pullNumber,
      head: review.head,
      reviewer: review.reviewer,
      body: review.body,
      receivedAt: review.receivedAt,
    })
    .onConflictDoNothing({ target: pullReview.reviewId })
    .returning({ reviewId: pullReview.reviewId })
    .all();
  if (inserted.length === 0) return false;
  // A review waits out the same quiet minute as comments, so the bot reviews and comments that
  // follow it reach the agent in the same restart.
  deferPullFeedback(db, review.itemId, review.receivedAt, wait);
  // No `itemId` in the payload: a restart cancels the item's jobs, and this one must outlive them.
  enqueueJobOnce(db, {
    queue: JOB_KIND.pullReview,
    jobKey: pullReviewJobKey(review.reviewId),
    payload: { reviewId: review.reviewId },
    runAt: review.receivedAt + wait.quietMs,
    now: review.receivedAt,
  });
  return true;
}

export function getPullReview(db: Database, reviewId: number): PullReviewRecord | null {
  const row = orm(db).select().from(pullReview).where(eq(pullReview.reviewId, reviewId)).get();
  return row === undefined ? null : mapRow(row);
}

/** Changes-requested reviews of this item that have not reached the agent or the team yet. */
export function pendingChangeRequests(db: Database, itemId: string): PullReviewRecord[] {
  return orm(db)
    .select()
    .from(pullReview)
    .where(
      and(
        eq(pullReview.itemId, itemId),
        eq(pullReview.state, "changes_requested"),
        isNull(pullReview.handledAt),
      ),
    )
    .orderBy(asc(pullReview.reviewId))
    .all()
    .map(mapRow);
}

/** Run this item's pending review jobs now, for a merge that waits on them. */
export function wakePullReviews(
  db: Database,
  itemId: string,
  now: number,
  wait: PullFeedbackWait = DEFAULT_PULL_FEEDBACK_WAIT,
): void {
  const latest = orm(db).all<{ at: number | null }>(
    sql`SELECT MAX(at) AS at FROM (
         SELECT received_at AS at FROM pull_review WHERE item_id = ${itemId} AND handled_at IS NULL
         UNION ALL SELECT received_at FROM pull_comment WHERE item_id = ${itemId} AND handled_at IS NULL
         UNION ALL SELECT observed_at FROM pull_ci_failure WHERE item_id = ${itemId} AND handled_at IS NULL)`,
  )[0]?.at;
  orm(db)
    .update(job)
    .set({
      runAt: sql`MIN(${job.runAt}, MAX(${now}, MIN(${job.createdAt} + ${Math.max(wait.maxMs, wait.quietMs)}, ${latest == null ? now : latest + wait.quietMs})))`,
    })
    .where(
      and(
        eq(job.queue, JOB_KIND.pullReview),
        eq(job.status, "pending"),
        sql`${job.jobKey} IN (SELECT 'pull-review:' || review_id FROM pull_review
                              WHERE item_id = ${itemId} AND handled_at IS NULL)`,
      ),
    )
    .run();
}

export function settlePullReview(
  db: Database,
  reviewId: number,
  outcome: PullReviewOutcome,
  now: number,
): boolean {
  return (
    orm(db)
      .update(pullReview)
      .set({ handledAt: now, outcome })
      .where(and(eq(pullReview.reviewId, reviewId), isNull(pullReview.handledAt)))
      .returning({ reviewId: pullReview.reviewId })
      .all().length > 0
  );
}

function mapRow(row: Row): PullReviewRecord {
  return {
    reviewId: row.reviewId,
    itemId: row.itemId,
    state: row.state as PullReviewState,
    pullNumber: row.pullNumber,
    head: row.head,
    reviewer: row.reviewer,
    body: row.body,
    receivedAt: row.receivedAt,
    handledAt: row.handledAt,
    outcome: row.outcome as PullReviewOutcome | null,
  };
}
