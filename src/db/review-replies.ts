import type { Database } from "bun:sqlite";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { orm } from "./orm";
import { reviewReply } from "./schema";

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
  orm(db)
    .delete(reviewReply)
    .where(
      and(
        eq(reviewReply.itemId, input.itemId),
        isNull(reviewReply.outcome),
        isNull(reviewReply.repliedAt),
      ),
    )
    .run();
  for (const reply of input.replies)
    orm(db)
      .insert(reviewReply)
      .values({
        itemId: input.itemId,
        restartKey: input.restartKey,
        number: reply.number,
        pullNumber: reply.pullNumber,
        target: reply.target,
        commentId: reply.commentId,
        threadId: reply.threadId,
        author: reply.author,
        excerpt: reply.excerpt,
        recordedAt: input.now,
      })
      .onConflictDoNothing({ target: [reviewReply.restartKey, reviewReply.number] })
      .run();
}

/** This item's handed-off comments the agent has not reported on yet, by number. */
export function unreportedReviewReplies(db: Database, itemId: string): ReviewReplyRecord[] {
  return orm(db)
    .select()
    .from(reviewReply)
    .where(and(eq(reviewReply.itemId, itemId), isNull(reviewReply.outcome)))
    .orderBy(reviewReply.number)
    .all() as ReviewReplyRecord[];
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
    stored += orm(db)
      .update(reviewReply)
      .set({
        outcome: report?.outcome ?? "unreported",
        reply: report?.reply ?? null,
        reportedAt: now,
      })
      .where(and(eq(reviewReply.id, open.id), isNull(reviewReply.outcome)))
      .returning({ id: reviewReply.id })
      .all().length;
  }
  return stored;
}

/** Reported replies on pull request `pullNumber` that Paws has not posted yet. */
export function unpostedReviewReplies(
  db: Database,
  itemId: string,
  pullNumber: number,
): ReviewReplyRecord[] {
  return orm(db)
    .select()
    .from(reviewReply)
    .where(
      and(
        eq(reviewReply.itemId, itemId),
        eq(reviewReply.pullNumber, pullNumber),
        isNotNull(reviewReply.outcome),
        isNull(reviewReply.repliedAt),
      ),
    )
    .orderBy(reviewReply.recordedAt, reviewReply.number)
    .all() as ReviewReplyRecord[];
}

export function markReviewReplyPosted(
  db: Database,
  id: number,
  now: number,
  resolved: boolean,
): void {
  orm(db)
    .update(reviewReply)
    .set({
      repliedAt: sql`COALESCE(${reviewReply.repliedAt}, ${now})`,
      resolvedAt: resolved ? now : null,
    })
    .where(eq(reviewReply.id, id))
    .run();
}
