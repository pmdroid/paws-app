import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import { enqueueJobOnce } from "./jobs";
import { deferPullFeedback, PULL_COMMENT_SETTLE_MS } from "./pull-comments";

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

type Row = {
  review_id: number;
  item_id: string;
  state: PullReviewState;
  pull_number: number;
  head: string | null;
  reviewer: string | null;
  body: string;
  received_at: number;
  handled_at: number | null;
  outcome: PullReviewOutcome | null;
};

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
): boolean {
  const inserted = db.run(
    `INSERT INTO pull_review (review_id, item_id, state, pull_number, head, reviewer, body, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(review_id) DO NOTHING`,
    [
      review.reviewId,
      review.itemId,
      review.state,
      review.pullNumber,
      review.head,
      review.reviewer,
      review.body,
      review.receivedAt,
    ],
  );
  if (inserted.changes === 0) return false;
  // A review waits out the same quiet minute as comments, so the bot reviews and comments that
  // follow it reach the agent in the same restart.
  deferPullFeedback(db, review.itemId, review.receivedAt);
  // No `itemId` in the payload: a restart cancels the item's jobs, and this one must outlive them.
  enqueueJobOnce(db, {
    queue: JOB_KIND.pullReview,
    jobKey: pullReviewJobKey(review.reviewId),
    payload: { reviewId: review.reviewId },
    runAt: review.receivedAt + PULL_COMMENT_SETTLE_MS,
    now: review.receivedAt,
  });
  return true;
}

export function getPullReview(db: Database, reviewId: number): PullReviewRecord | null {
  const row = db
    .query<Row, [number]>("SELECT * FROM pull_review WHERE review_id = ?")
    .get(reviewId);
  return row === null ? null : mapRow(row);
}

/** Changes-requested reviews of this item that have not reached the agent or the team yet. */
export function pendingChangeRequests(db: Database, itemId: string): PullReviewRecord[] {
  return db
    .query<Row, [string]>(
      `SELECT * FROM pull_review WHERE item_id = ? AND state = 'changes_requested'
       AND handled_at IS NULL ORDER BY review_id`,
    )
    .all(itemId)
    .map(mapRow);
}

/** Run this item's pending review jobs now, for a merge that waits on them. */
export function wakePullReviews(db: Database, itemId: string, now: number): void {
  db.run(
    `UPDATE job SET run_at = MIN(run_at, ?) WHERE queue = ? AND status = 'pending'
       AND job_key IN (SELECT 'pull-review:' || review_id FROM pull_review
                       WHERE item_id = ? AND handled_at IS NULL)`,
    [now, JOB_KIND.pullReview, itemId],
  );
}

export function settlePullReview(
  db: Database,
  reviewId: number,
  outcome: PullReviewOutcome,
  now: number,
): boolean {
  return (
    db.run(
      "UPDATE pull_review SET handled_at = ?, outcome = ? WHERE review_id = ? AND handled_at IS NULL",
      [now, outcome, reviewId],
    ).changes > 0
  );
}

function mapRow(row: Row): PullReviewRecord {
  return {
    reviewId: row.review_id,
    itemId: row.item_id,
    state: row.state,
    pullNumber: row.pull_number,
    head: row.head,
    reviewer: row.reviewer,
    body: row.body,
    receivedAt: row.received_at,
    handledAt: row.handled_at,
    outcome: row.outcome,
  };
}
