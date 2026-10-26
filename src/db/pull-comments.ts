import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import { enqueueJobOnce } from "./jobs";

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

type Row = {
  source: PullCommentSource;
  comment_id: number;
  item_id: string;
  pull_number: number;
  review_id: number | null;
  author: string | null;
  body: string;
  path: string | null;
  line: number | null;
  received_at: number;
  handled_at: number | null;
  outcome: PullCommentOutcome | null;
};

/** Quiet time after the last comment before the comments go to the agent together. */
export const PULL_COMMENT_SETTLE_MS = 60_000;
/** The longest a steady stream of comments delays the restart. */
export const PULL_COMMENT_MAX_SETTLE_MS = 5 * 60_000;

/**
 * Record a pull request comment once by its source and GitHub id, and make sure one pending job
 * gathers the item's comments. A comment that arrives while that job is pending moves it to a
 * minute after this comment, so comments close together become one restart. False when the
 * comment was already recorded. Call inside a transaction.
 */
export function recordPullComment(
  db: Database,
  comment: Omit<PullCommentRecord, "handledAt" | "outcome">,
): boolean {
  const inserted = db.run(
    `INSERT INTO pull_comment (source, comment_id, item_id, pull_number, review_id, author, body, path, line, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source, comment_id) DO NOTHING`,
    [
      comment.source,
      comment.commentId,
      comment.itemId,
      comment.pullNumber,
      comment.reviewId,
      comment.author,
      comment.body,
      comment.path,
      comment.line,
      comment.receivedAt,
    ],
  );
  if (inserted.changes === 0) return false;
  const settle = comment.receivedAt + PULL_COMMENT_SETTLE_MS;
  const moved = db.run(
    `UPDATE job SET run_at = MIN(MAX(run_at, ?), created_at + ?)
     WHERE queue = ? AND status = 'pending' AND json_extract(payload, '$.pullCommentsFor') = ?`,
    [settle, PULL_COMMENT_MAX_SETTLE_MS, JOB_KIND.pullComments, comment.itemId],
  );
  if (moved.changes > 0) return true;
  enqueueJobOnce(db, {
    queue: JOB_KIND.pullComments,
    jobKey: `pull-comments:${comment.itemId}:${comment.source}:${comment.commentId}`,
    payload: { pullCommentsFor: comment.itemId },
    runAt: settle,
    now: comment.receivedAt,
  });
  return true;
}

/** This item's comments that have not reached the agent or the team yet, oldest first. */
export function pendingPullComments(db: Database, itemId: string): PullCommentRecord[] {
  return db
    .query<Row, [string]>(
      `SELECT * FROM pull_comment WHERE item_id = ? AND handled_at IS NULL
       ORDER BY received_at, comment_id`,
    )
    .all(itemId)
    .map(mapRow);
}

export function getPullComment(
  db: Database,
  source: PullCommentSource,
  commentId: number,
): PullCommentRecord | null {
  const row = db
    .query<Row, [string, number]>("SELECT * FROM pull_comment WHERE source = ? AND comment_id = ?")
    .get(source, commentId);
  return row === null ? null : mapRow(row);
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
    settled += db.run(
      `UPDATE pull_comment SET handled_at = ?, outcome = ?
       WHERE source = ? AND comment_id = ? AND handled_at IS NULL`,
      [now, outcome, comment.source, comment.commentId],
    ).changes;
  return settled;
}

function mapRow(row: Row): PullCommentRecord {
  return {
    source: row.source,
    commentId: row.comment_id,
    itemId: row.item_id,
    pullNumber: row.pull_number,
    reviewId: row.review_id,
    author: row.author,
    body: row.body,
    path: row.path,
    line: row.line,
    receivedAt: row.received_at,
    handledAt: row.handled_at,
    outcome: row.outcome,
  };
}
