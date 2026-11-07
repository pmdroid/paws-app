import type { Database } from "bun:sqlite";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";

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

type ReviewReplyHandoff = {
  itemId: string;
  restartKey: string;
  replies: readonly NewReviewReply[];
  now: number;
};

/**
 * Record the comments one restart hands to the agent, numbered as the handoff numbers them.
 * Targets an earlier round recorded and the agent has not reported on yet are superseded: the new
 * handoff carries their threads again. Call inside the restart's transaction.
 */
export function* recordReviewRepliesSteps(q: Q, input: ReviewReplyHandoff): Steps<void> {
  const { reviewReply } = q.t;
  yield* q.exec(
    q.orm
      .delete(reviewReply)
      .where(
        and(
          eq(reviewReply.itemId, input.itemId),
          isNull(reviewReply.outcome),
          isNull(reviewReply.repliedAt),
        ),
      ),
  );
  for (const reply of input.replies)
    yield* q.exec(
      q.orm
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
        .onConflictDoNothing({ target: [reviewReply.restartKey, reviewReply.number] }),
    );
}

export function recordReviewReplies(db: Database, input: ReviewReplyHandoff): void {
  settled(sqliteDb(db).run((q) => recordReviewRepliesSteps(q, input)));
}

/** This item's handed-off comments the agent has not reported on yet, by number. */
export function* unreportedReviewRepliesSteps(q: Q, itemId: string): Steps<ReviewReplyRecord[]> {
  const { reviewReply } = q.t;
  return (yield* q.all(
    q.orm
      .select()
      .from(reviewReply)
      .where(and(eq(reviewReply.itemId, itemId), isNull(reviewReply.outcome)))
      .orderBy(reviewReply.number),
  )) as ReviewReplyRecord[];
}

export function unreportedReviewReplies(db: Database, itemId: string): ReviewReplyRecord[] {
  return settled(sqliteDb(db).run((q) => unreportedReviewRepliesSteps(q, itemId)));
}

type ReviewReplyReports = ReadonlyMap<
  number,
  { outcome: Exclude<ReviewReplyOutcome, "unreported">; reply: string }
>;

/**
 * Store what the fix turn reported for each handed-off comment. A comment the report leaves out is
 * `unreported`. The number stored.
 */
export function* reportReviewRepliesSteps(
  q: Q,
  itemId: string,
  reports: ReviewReplyReports,
  now: number,
): Steps<number> {
  const { reviewReply } = q.t;
  let stored = 0;
  for (const open of yield* unreportedReviewRepliesSteps(q, itemId)) {
    const report = reports.get(open.number);
    stored += (yield* q.all(
      q.orm
        .update(reviewReply)
        .set({
          outcome: report?.outcome ?? "unreported",
          reply: report?.reply ?? null,
          reportedAt: now,
        })
        .where(and(eq(reviewReply.id, open.id), isNull(reviewReply.outcome)))
        .returning({ id: reviewReply.id }),
    )).length;
  }
  return stored;
}

export function reportReviewReplies(
  db: Database,
  itemId: string,
  reports: ReviewReplyReports,
  now: number,
): number {
  return settled(sqliteDb(db).run((q) => reportReviewRepliesSteps(q, itemId, reports, now)));
}

/** Reported replies on pull request `pullNumber` that Paws has not posted yet. */
export function* unpostedReviewRepliesSteps(
  q: Q,
  itemId: string,
  pullNumber: number,
): Steps<ReviewReplyRecord[]> {
  const { reviewReply } = q.t;
  return (yield* q.all(
    q.orm
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
      .orderBy(reviewReply.recordedAt, reviewReply.number),
  )) as ReviewReplyRecord[];
}

export function unpostedReviewReplies(
  db: Database,
  itemId: string,
  pullNumber: number,
): ReviewReplyRecord[] {
  return settled(sqliteDb(db).run((q) => unpostedReviewRepliesSteps(q, itemId, pullNumber)));
}

export function* markReviewReplyPostedSteps(
  q: Q,
  id: number,
  now: number,
  resolved: boolean,
): Steps<void> {
  const { reviewReply } = q.t;
  yield* q.exec(
    q.orm
      .update(reviewReply)
      .set({
        repliedAt: sql`COALESCE(${reviewReply.repliedAt}, ${now})`,
        resolvedAt: resolved ? now : null,
      })
      .where(eq(reviewReply.id, id)),
  );
}

export function markReviewReplyPosted(
  db: Database,
  id: number,
  now: number,
  resolved: boolean,
): void {
  settled(sqliteDb(db).run((q) => markReviewReplyPostedSteps(q, id, now, resolved)));
}
