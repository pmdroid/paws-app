import type { Database } from "bun:sqlite";
import { and, asc, count, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { settled, sqliteDb, type Q } from "./db";
import { emitJobReady, enqueueJobOnceSteps } from "./jobs";
import { jsonField } from "./json-text";

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

type Row = Q["t"]["pullComment"]["$inferSelect"];

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

/** The smallest of the values: scalar `MIN` on SQLite, `LEAST` on Postgres. */
export function least(q: Q, ...values: SQL[]): SQL<number> {
  return sql`${sql.raw(q.dialect === "sqlite" ? "MIN" : "LEAST")}(${sql.join(values, sql`, `)})`;
}

/** The largest of the values: scalar `MAX` on SQLite, `GREATEST` on Postgres. */
export function greatest(q: Q, ...values: SQL[]): SQL<number> {
  return sql`${sql.raw(q.dialect === "sqlite" ? "MAX" : "GREATEST")}(${sql.join(values, sql`, `)})`;
}

/**
 * Move the item's pending comment job and changes-requested review jobs to a quiet minute after
 * `receivedAt`, never past five minutes after each job was created. A review and the comments and
 * bot reviews that follow it then reach the agent in one restart. The number of jobs moved.
 */
export function* deferPullFeedbackSteps(
  q: Q,
  itemId: string,
  receivedAt: number,
  wait: PullFeedbackWait = DEFAULT_PULL_FEEDBACK_WAIT,
) {
  const { job } = q.t;
  const moved = yield* q.all(
    q.orm
      .update(job)
      .set({
        runAt: least(
          q,
          greatest(q, sql`${job.runAt}`, sql`${receivedAt + wait.quietMs}`),
          sql`${job.createdAt} + ${Math.max(wait.maxMs, wait.quietMs)}`,
        ),
      })
      .where(and(eq(job.status, "pending"), pullFeedbackJobs(q, itemId)))
      .returning({ id: job.id }),
  );
  return moved.length;
}

/** The item's pending comment job and the jobs of its open reviews. */
function pullFeedbackJobs(q: Q, itemId: string) {
  const { job } = q.t;
  return or(
    and(
      eq(job.queue, JOB_KIND.pullComments),
      eq(jsonField(q, job.payload, "pullCommentsFor"), itemId),
    ),
    and(eq(job.queue, JOB_KIND.pullReview), openReviewJobs(q, itemId)),
  );
}

/** The job keys of this item's reviews that are still open. */
export function openReviewJobs(q: Q, itemId: string): SQL {
  const { job, pullReview } = q.t;
  return inArray(
    job.jobKey,
    q.orm
      .select({ key: sql<string>`'pull-review:' || ${pullReview.reviewId}` })
      .from(pullReview)
      .where(and(eq(pullReview.itemId, itemId), isNull(pullReview.handledAt))),
  );
}

/**
 * Record a pull request comment once by its source and GitHub id, and make sure one pending job
 * gathers the item's comments. A comment moves that job and the item's pending review jobs to a
 * minute after this comment, so comments and reviews close together become one restart. False when the
 * comment was already recorded. Call inside a transaction. `enqueued`: this call added the job.
 */
export function* recordPullCommentSteps(
  q: Q,
  comment: Omit<PullCommentRecord, "handledAt" | "outcome">,
  wait: PullFeedbackWait = DEFAULT_PULL_FEEDBACK_WAIT,
) {
  const { pullComment } = q.t;
  const inserted = yield* q.all(
    q.orm
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
      .returning({ commentId: pullComment.commentId }),
  );
  if (inserted.length === 0) return { recorded: false, enqueued: false };
  const enqueued = yield* gatherPullFeedbackSteps(
    q,
    comment.itemId,
    comment.receivedAt,
    wait,
    `pull-comments:${comment.itemId}:${comment.source}:${comment.commentId}`,
  );
  return { recorded: true, enqueued };
}

export function recordPullComment(
  db: Database,
  comment: Omit<PullCommentRecord, "handledAt" | "outcome">,
  wait: PullFeedbackWait = DEFAULT_PULL_FEEDBACK_WAIT,
): boolean {
  const { recorded, enqueued } = settled(
    sqliteDb(db).run((q) => recordPullCommentSteps(q, comment, wait)),
  );
  if (enqueued) emitJobReady(db);
  return recorded;
}

/** Defer the item's feedback jobs, and enqueue the comment job unless one is pending. True when this call enqueued it. */
export function* gatherPullFeedbackSteps(
  q: Q,
  itemId: string,
  receivedAt: number,
  wait: PullFeedbackWait,
  jobKey: string,
) {
  const { job } = q.t;
  yield* deferPullFeedbackSteps(q, itemId, receivedAt, wait);
  const gathering = yield* q.one(
    q.orm
      .select({ n: count() })
      .from(job)
      .where(
        and(
          eq(job.queue, JOB_KIND.pullComments),
          eq(job.status, "pending"),
          eq(jsonField(q, job.payload, "pullCommentsFor"), itemId),
        ),
      ),
  );
  if ((gathering?.n ?? 0) > 0) return false;
  const { inserted } = yield* enqueueJobOnceSteps(q, {
    queue: JOB_KIND.pullComments,
    jobKey,
    payload: { pullCommentsFor: itemId },
    runAt: receivedAt + wait.quietMs,
    now: receivedAt,
  });
  return inserted;
}

/** This item's comments that have not reached the agent or the team yet, oldest first. */
export function* pendingPullCommentsSteps(q: Q, itemId: string) {
  const { pullComment } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(pullComment)
      .where(and(eq(pullComment.itemId, itemId), isNull(pullComment.handledAt)))
      .orderBy(asc(pullComment.receivedAt), asc(pullComment.commentId)),
  );
  return rows.map(mapRow);
}

export function pendingPullComments(db: Database, itemId: string): PullCommentRecord[] {
  return settled(sqliteDb(db).run((q) => pendingPullCommentsSteps(q, itemId)));
}

export function* getPullCommentSteps(q: Q, source: PullCommentSource, commentId: number) {
  const { pullComment } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(pullComment)
      .where(and(eq(pullComment.source, source), eq(pullComment.commentId, commentId))),
  );
  return row === undefined ? null : mapRow(row);
}

export function getPullComment(
  db: Database,
  source: PullCommentSource,
  commentId: number,
): PullCommentRecord | null {
  return settled(sqliteDb(db).run((q) => getPullCommentSteps(q, source, commentId)));
}

/** Settle the given comments that are still open. The number settled. */
export function* settlePullCommentsSteps(
  q: Q,
  comments: readonly Pick<PullCommentRecord, "source" | "commentId">[],
  outcome: PullCommentOutcome,
  now: number,
) {
  const { pullComment } = q.t;
  let settledCount = 0;
  for (const comment of comments)
    settledCount += (yield* q.all(
      q.orm
        .update(pullComment)
        .set({ handledAt: now, outcome })
        .where(
          and(
            eq(pullComment.source, comment.source),
            eq(pullComment.commentId, comment.commentId),
            isNull(pullComment.handledAt),
          ),
        )
        .returning({ commentId: pullComment.commentId }),
    )).length;
  return settledCount;
}

export function settlePullComments(
  db: Database,
  comments: readonly Pick<PullCommentRecord, "source" | "commentId">[],
  outcome: PullCommentOutcome,
  now: number,
): number {
  return settled(sqliteDb(db).run((q) => settlePullCommentsSteps(q, comments, outcome, now)));
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

export function* commentingAppsSteps(q: Q, owner: string, repo: string) {
  const { pullComment, workItemRepository } = q.t;
  const rows = yield* q.all(
    q.orm
      .selectDistinct({ login: sql<string>`lower(${pullComment.author})` })
      .from(pullComment)
      .innerJoin(workItemRepository, eq(workItemRepository.itemId, pullComment.itemId))
      .where(
        and(
          sql`lower(${workItemRepository.owner}) = lower(${owner})`,
          sql`lower(${workItemRepository.repo}) = lower(${repo})`,
          sql`lower(${pullComment.author}) LIKE '%[bot]'`,
        ),
      ),
  );
  return rows.map((row) => row.login.slice(0, -"[bot]".length));
}

export function commentingApps(db: Database, owner: string, repo: string): string[] {
  return settled(sqliteDb(db).run((q) => commentingAppsSteps(q, owner, repo)));
}

export function* pullReviewCheckWaitSteps(q: Q, itemId: string) {
  const { job } = q.t;
  const reviewChecks = jsonField(q, job.payload, "reviewChecks");
  const row = yield* q.one(
    q.orm
      .select({ wait: reviewChecks })
      .from(job)
      .where(
        and(
          inArray(job.status, ["pending", "running"]),
          sql`${reviewChecks} IS NOT NULL`,
          pullFeedbackJobs(q, itemId),
        ),
      )
      .orderBy(desc(job.id))
      .limit(1),
  );
  if (!row?.wait) return null;
  const wait = JSON.parse(row.wait) as Partial<ReviewCheckWait>;
  return typeof wait.head === "string" && Array.isArray(wait.names)
    ? { head: wait.head, names: wait.names.filter((name) => typeof name === "string") }
    : null;
}

export function pullReviewCheckWait(db: Database, itemId: string): ReviewCheckWait | null {
  return settled(sqliteDb(db).run((q) => pullReviewCheckWaitSteps(q, itemId)));
}
