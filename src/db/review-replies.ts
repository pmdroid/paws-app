import type { Database } from "bun:sqlite";

/**
 * Where Paws answers one comment it handed to the agent. `thread`: an inline review thread, answered
 * in the thread and resolved when addressed. `review`: a review's own body. `conversation`: a
 * pull request conversation comment. The last two are answered in the conversation.
 */
export type ReviewReplyTarget = "thread" | "review" | "conversation";
/** `unreported`: the fix turn ended without a reply for this comment. */
export type ReviewReplyOutcome = "fixed" | "answered" | "not_changed" | "unreported";

export type ReviewReplyRecord = {
  id: number;
  itemId: string;
  restartKey: string;
  number: number;
  pullNumber: number;
  target: ReviewReplyTarget;
  commentId: number | null;
  threadId: string | null;
  author: string | null;
  excerpt: string;
  recordedAt: number;
  outcome: ReviewReplyOutcome | null;
  reply: string | null;
  reportedAt: number | null;
  repliedAt: number | null;
  resolvedAt: number | null;
};

type Row = {
  id: number;
  item_id: string;
  restart_key: string;
  number: number;
  pull_number: number;
  target: ReviewReplyTarget;
  comment_id: number | null;
  thread_id: string | null;
  author: string | null;
  excerpt: string;
  recorded_at: number;
  outcome: ReviewReplyOutcome | null;
  reply: string | null;
  reported_at: number | null;
  replied_at: number | null;
  resolved_at: number | null;
};

export type NewReviewReply = Pick<
  ReviewReplyRecord,
  "number" | "pullNumber" | "target" | "commentId" | "threadId" | "author" | "excerpt"
>;

/**
 * Record the comments one restart hands to the agent, numbered as the handoff numbers them.
 * Targets an earlier round recorded and the agent has not reported on yet are superseded: the new
 * handoff carries their threads again. Call inside the restart's transaction.
 */
export function recordReviewReplies(
  db: Database,
  input: { itemId: string; restartKey: string; replies: readonly NewReviewReply[]; now: number },
): void {
  db.run(`DELETE FROM review_reply WHERE item_id = ? AND outcome IS NULL AND replied_at IS NULL`, [
    input.itemId,
  ]);
  for (const reply of input.replies)
    db.run(
      `INSERT INTO review_reply (item_id, restart_key, number, pull_number, target, comment_id,
         thread_id, author, excerpt, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(restart_key, number) DO NOTHING`,
      [
        input.itemId,
        input.restartKey,
        reply.number,
        reply.pullNumber,
        reply.target,
        reply.commentId,
        reply.threadId,
        reply.author,
        reply.excerpt,
        input.now,
      ],
    );
}

/** This item's handed-off comments the agent has not reported on yet, by number. */
export function unreportedReviewReplies(db: Database, itemId: string): ReviewReplyRecord[] {
  return db
    .query<Row, [string]>(
      `SELECT * FROM review_reply WHERE item_id = ? AND outcome IS NULL ORDER BY number`,
    )
    .all(itemId)
    .map(mapRow);
}

/**
 * Store what the fix turn reported for each handed-off comment. A comment the report leaves out is
 * `unreported`. The number stored.
 */
export function reportReviewReplies(
  db: Database,
  itemId: string,
  reports: ReadonlyMap<
    number,
    { outcome: Exclude<ReviewReplyOutcome, "unreported">; reply: string }
  >,
  now: number,
): number {
  let stored = 0;
  for (const open of unreportedReviewReplies(db, itemId)) {
    const report = reports.get(open.number);
    stored += db.run(
      `UPDATE review_reply SET outcome = ?, reply = ?, reported_at = ? WHERE id = ? AND outcome IS NULL`,
      [report?.outcome ?? "unreported", report?.reply ?? null, now, open.id],
    ).changes;
  }
  return stored;
}

/** Reported replies on pull request `pullNumber` that Paws has not posted yet. */
export function unpostedReviewReplies(
  db: Database,
  itemId: string,
  pullNumber: number,
): ReviewReplyRecord[] {
  return db
    .query<Row, [string, number]>(
      `SELECT * FROM review_reply WHERE item_id = ? AND pull_number = ? AND outcome IS NOT NULL
         AND (replied_at IS NULL OR (target = 'thread' AND thread_id IS NOT NULL
           AND outcome = 'fixed' AND resolved_at IS NULL)) ORDER BY recorded_at, number`,
    )
    .all(itemId, pullNumber)
    .map(mapRow);
}

export function markReviewReplyPosted(
  db: Database,
  id: number,
  now: number,
  resolved: boolean,
): void {
  db.run(
    `UPDATE review_reply SET replied_at = COALESCE(replied_at, ?), resolved_at = ? WHERE id = ?`,
    [now, resolved ? now : null, id],
  );
}

function mapRow(row: Row): ReviewReplyRecord {
  return {
    id: row.id,
    itemId: row.item_id,
    restartKey: row.restart_key,
    number: row.number,
    pullNumber: row.pull_number,
    target: row.target,
    commentId: row.comment_id,
    threadId: row.thread_id,
    author: row.author,
    excerpt: row.excerpt,
    recordedAt: row.recorded_at,
    outcome: row.outcome,
    reply: row.reply,
    reportedAt: row.reported_at,
    repliedAt: row.replied_at,
    resolvedAt: row.resolved_at,
  };
}
