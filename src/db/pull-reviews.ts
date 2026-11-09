import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { settled, sqliteDb, type Q } from "./db";
import { emitJobReady, enqueueJobOnceSteps } from "./jobs";
import {
  DEFAULT_PULL_FEEDBACK_WAIT,
  deferPullFeedbackSteps,
  greatest,
  least,
  openReviewJobs,
  type PullFeedbackWait,
} from "./pull-comments";

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

type Row = Q["t"]["pullReview"]["$inferSelect"];

export function pullReviewJobKey(reviewId: number): string {
  return `pull-review:${reviewId}`;
}

/**
 * Record a submitted review once by its GitHub id and enqueue the job that acts on it a quiet
 * minute later. False when the id was already recorded, so a redelivered webhook does nothing.
 * Call inside a transaction. `enqueued`: this call added the job.
 */
export function* recordPullReviewSteps(
  q: Q,
  review: Omit<PullReviewRecord, "handledAt" | "outcome">,
  wait: PullFeedbackWait = DEFAULT_PULL_FEEDBACK_WAIT,
) {
  const { pullReview } = q.t;
  const inserted = yield* q.all(
    q.orm
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
      .returning({ reviewId: pullReview.reviewId }),
  );
  if (inserted.length === 0) return { recorded: false, enqueued: false };
  // A review waits out the same quiet minute as comments, so the bot reviews and comments that
  // follow it reach the agent in the same restart.
  yield* deferPullFeedbackSteps(q, review.itemId, review.receivedAt, wait);
  // No `itemId` in the payload: a restart cancels the item's jobs, and this one must outlive them.
  const { inserted: enqueued } = yield* enqueueJobOnceSteps(q, {
    queue: JOB_KIND.pullReview,
    jobKey: pullReviewJobKey(review.reviewId),
    payload: { reviewId: review.reviewId },
    runAt: review.receivedAt + wait.quietMs,
    now: review.receivedAt,
  });
  return { recorded: true, enqueued };
}

export function recordPullReview(
  db: Database,
  review: Omit<PullReviewRecord, "handledAt" | "outcome">,
  wait: PullFeedbackWait = DEFAULT_PULL_FEEDBACK_WAIT,
): boolean {
  const { recorded, enqueued } = settled(
    sqliteDb(db).run((q) => recordPullReviewSteps(q, review, wait)),
  );
  if (enqueued) emitJobReady(db);
  return recorded;
}

export function* getPullReviewSteps(q: Q, reviewId: number) {
  const { pullReview } = q.t;
  const row = yield* q.one(
    q.orm.select().from(pullReview).where(eq(pullReview.reviewId, reviewId)),
  );
  return row === undefined ? null : mapRow(row);
}

export function getPullReview(db: Database, reviewId: number): PullReviewRecord | null {
  return settled(sqliteDb(db).run((q) => getPullReviewSteps(q, reviewId)));
}

/** Changes-requested reviews of this item that have not reached the agent or the team yet. */
export function* pendingChangeRequestsSteps(q: Q, itemId: string) {
  const { pullReview } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(pullReview)
      .where(
        and(
          eq(pullReview.itemId, itemId),
          eq(pullReview.state, "changes_requested"),
          isNull(pullReview.handledAt),
        ),
      )
      .orderBy(asc(pullReview.reviewId)),
  );
  return rows.map(mapRow);
}

export function pendingChangeRequests(db: Database, itemId: string): PullReviewRecord[] {
  return settled(sqliteDb(db).run((q) => pendingChangeRequestsSteps(q, itemId)));
}

/** Run this item's pending review jobs now, for a merge that waits on them. */
export function* wakePullReviewsSteps(
  q: Q,
  itemId: string,
  now: number,
  wait: PullFeedbackWait = DEFAULT_PULL_FEEDBACK_WAIT,
) {
  const { job } = q.t;
  const latest = (yield* q.one(
    q.orm.select({ at: sql<number | null>`MAX(at)`.mapWith(Number) }).from(
      sql`(SELECT received_at AS at FROM pull_review WHERE item_id = ${itemId} AND handled_at IS NULL
         UNION ALL SELECT received_at FROM pull_comment WHERE item_id = ${itemId} AND handled_at IS NULL
         UNION ALL SELECT observed_at FROM pull_ci_failure WHERE item_id = ${itemId} AND handled_at IS NULL) AS feedback`,
    ),
  ))?.at;
  yield* q.exec(
    q.orm
      .update(job)
      .set({
        runAt: least(
          q,
          sql`${job.runAt}`,
          greatest(
            q,
            sql`${now}`,
            least(
              q,
              sql`${job.createdAt} + ${Math.max(wait.maxMs, wait.quietMs)}`,
              sql`${latest == null ? now : latest + wait.quietMs}`,
            ),
          ),
        ),
      })
      .where(
        and(
          eq(job.queue, JOB_KIND.pullReview),
          eq(job.status, "pending"),
          openReviewJobs(q, itemId),
        ),
      ),
  );
}

export function wakePullReviews(
  db: Database,
  itemId: string,
  now: number,
  wait: PullFeedbackWait = DEFAULT_PULL_FEEDBACK_WAIT,
): void {
  settled(sqliteDb(db).run((q) => wakePullReviewsSteps(q, itemId, now, wait)));
}

export function* settlePullReviewSteps(
  q: Q,
  reviewId: number,
  outcome: PullReviewOutcome,
  now: number,
) {
  const { pullReview } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(pullReview)
      .set({ handledAt: now, outcome })
      .where(and(eq(pullReview.reviewId, reviewId), isNull(pullReview.handledAt)))
      .returning({ reviewId: pullReview.reviewId }),
  );
  return rows.length > 0;
}

export function settlePullReview(
  db: Database,
  reviewId: number,
  outcome: PullReviewOutcome,
  now: number,
): boolean {
  return settled(sqliteDb(db).run((q) => settlePullReviewSteps(q, reviewId, outcome, now)));
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

/** Items still in flight on this repository, newest first. */
export function* openItemIdsForRepositorySteps(q: Q, owner: string, repo: string) {
  const { workItem, workItemRepository } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ id: workItem.id })
      .from(workItem)
      .innerJoin(workItemRepository, eq(workItemRepository.itemId, workItem.id))
      .where(
        and(
          sql`lower(${workItemRepository.owner}) = lower(${owner})`,
          sql`lower(${workItemRepository.repo}) = lower(${repo})`,
          notInArray(workItem.state, ["cancelled", "merged", "completed", "failed", "manual"]),
        ),
      )
      .orderBy(desc(workItem.createdAt)),
  );
  return rows.map((row) => row.id);
}

export function openItemIdsForRepository(db: Database, owner: string, repo: string): string[] {
  return settled(sqliteDb(db).run((q) => openItemIdsForRepositorySteps(q, owner, repo)));
}
