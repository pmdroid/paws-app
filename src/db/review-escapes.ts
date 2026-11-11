import { and, eq, gte, isNull } from "drizzle-orm";
import { type Q, type Steps, type Db } from "./db";

/** What started a fix round after the pull request: failed CI, a changes-requested review, or comments. */
export type ReviewEscapeTrigger = "ci" | "review" | "comment";

/** Why a settled candidate does not count against the independent review. */
export type NotEscapeReason =
  /** Every failed check also fails on main. */
  | "flake"
  /** The fix only touched tests, docs or formatting. */
  | "tests_docs_format"
  /** The fix changed nothing. */
  | "no_change"
  /** A review or comment fix changed none of the files the independent review saw. */
  | "unreviewed";

export type ReviewEscapeDetail = {
  /** The failed checks, for `ci`. `failsOnBase` is true when the same check fails on main. */
  checks?: { name: string; failsOnBase: boolean }[];
  /** The review or comments, for `review` and `comment`. */
  comments?: { id: number; author: string | null; body: string }[];
};

export type ReviewEscapeRecord = {
  id: number;
  /** The restart's job key; one candidate per fix round. */
  triggerKey: string;
  itemId: string;
  trigger: ReviewEscapeTrigger;
  /** The head Closeout accepted before the fix round. */
  acceptedHead: string;
  pullNumber: number | null;
  detail: ReviewEscapeDetail;
  recordedAt: number;
  /** The head Closeout accepted after the fix, once it did. */
  fixHead: string | null;
  /** The files the fix changed, once settled. */
  files: string[] | null;
  /** True for an escape, false for not an escape, null until the fix is accepted. */
  escape: boolean | null;
  notEscapeReason: NotEscapeReason | null;
  settledAt: number | null;
};

type Row = Q["t"]["reviewEscape"]["$inferSelect"];

const COMMENT_CHARS = 500;

/** A JSON value as the dialect stores it: text on SQLite, jsonb on Postgres. */
function stored(q: Q, value: unknown): unknown {
  return q.dialect === "sqlite" ? JSON.stringify(value) : value;
}

function parsed<T>(q: Q, value: unknown): T {
  return (q.dialect === "sqlite" ? JSON.parse(value as string) : value) as T;
}

type ReviewEscapeCandidate = {
  triggerKey: string;
  itemId: string;
  trigger: ReviewEscapeTrigger;
  acceptedHead: string;
  pullNumber: number | null;
  detail: ReviewEscapeDetail;
  recordedAt: number;
};

/**
 * Record a candidate review escape for a fix round that started on an accepted head, once per
 * trigger key. False when the key was already recorded. Call inside the restart's transaction.
 */
export function* recordReviewEscapeSteps(q: Q, candidate: ReviewEscapeCandidate): Steps<boolean> {
  const { reviewEscape } = q.t;
  const detail: ReviewEscapeDetail = {
    ...candidate.detail,
    ...(candidate.detail.comments
      ? {
          comments: candidate.detail.comments.map((comment) => ({
            ...comment,
            body: comment.body.slice(0, COMMENT_CHARS),
          })),
        }
      : {}),
  };
  const inserted = yield* q.all(
    q.orm
      .insert(reviewEscape)
      .values({
        triggerKey: candidate.triggerKey,
        itemId: candidate.itemId,
        trigger: candidate.trigger,
        acceptedHead: candidate.acceptedHead,
        pullNumber: candidate.pullNumber,
        detail: stored(q, detail),
        recordedAt: candidate.recordedAt,
      })
      .onConflictDoNothing({ target: reviewEscape.triggerKey })
      .returning({ id: reviewEscape.id }),
  );
  return inserted.length > 0;
}

export async function recordReviewEscape(
  store: Db,
  candidate: ReviewEscapeCandidate,
): Promise<boolean> {
  return store.run((q) => recordReviewEscapeSteps(q, candidate));
}

/** This item's candidates whose fix Closeout has not accepted yet, oldest first. */
export function* openReviewEscapesSteps(q: Q, itemId: string): Steps<ReviewEscapeRecord[]> {
  const { reviewEscape } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(reviewEscape)
      .where(and(eq(reviewEscape.itemId, itemId), isNull(reviewEscape.settledAt)))
      .orderBy(reviewEscape.id),
  );
  return rows.map((row) => mapRow(q, row));
}

export async function openReviewEscapes(store: Db, itemId: string): Promise<ReviewEscapeRecord[]> {
  return store.run((q) => openReviewEscapesSteps(q, itemId));
}

type ReviewEscapeSettlement = {
  fixHead: string;
  files: readonly string[];
  escape: boolean;
  notEscapeReason: NotEscapeReason | null;
  now: number;
};

/** Settle an open candidate with the fix Closeout accepted. False when it was already settled. */
export function* settleReviewEscapeSteps(
  q: Q,
  id: number,
  settlement: ReviewEscapeSettlement,
): Steps<boolean> {
  const { reviewEscape } = q.t;
  const changed = yield* q.all(
    q.orm
      .update(reviewEscape)
      .set({
        fixHead: settlement.fixHead,
        files: stored(q, settlement.files),
        isEscape: settlement.escape ? 1 : 0,
        notEscapeReason: settlement.escape ? null : settlement.notEscapeReason,
        settledAt: settlement.now,
      })
      .where(and(eq(reviewEscape.id, id), isNull(reviewEscape.settledAt)))
      .returning({ id: reviewEscape.id }),
  );
  return changed.length > 0;
}

export async function settleReviewEscape(
  store: Db,
  id: number,
  settlement: ReviewEscapeSettlement,
): Promise<boolean> {
  return store.run((q) => settleReviewEscapeSteps(q, id, settlement));
}

/** Every candidate recorded at or after `since`, oldest first. */
export function* listReviewEscapesSteps(q: Q, since = 0): Steps<ReviewEscapeRecord[]> {
  const { reviewEscape } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(reviewEscape)
      .where(gte(reviewEscape.recordedAt, since))
      .orderBy(reviewEscape.id),
  );
  return rows.map((row) => mapRow(q, row));
}

export async function listReviewEscapes(store: Db, since = 0): Promise<ReviewEscapeRecord[]> {
  return store.run((q) => listReviewEscapesSteps(q, since));
}

function mapRow(q: Q, row: Row): ReviewEscapeRecord {
  return {
    id: row.id,
    triggerKey: row.triggerKey,
    itemId: row.itemId,
    trigger: row.trigger as ReviewEscapeTrigger,
    acceptedHead: row.acceptedHead,
    pullNumber: row.pullNumber,
    detail: parsed<ReviewEscapeDetail>(q, row.detail),
    recordedAt: row.recordedAt,
    fixHead: row.fixHead,
    files: row.files === null ? null : parsed<string[]>(q, row.files),
    escape: row.isEscape === null ? null : row.isEscape === 1,
    notEscapeReason: row.notEscapeReason as NotEscapeReason | null,
    settledAt: row.settledAt,
  };
}
