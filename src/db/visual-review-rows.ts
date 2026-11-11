import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";
import { type Q, type Steps, type Db } from "./db";
import { jsonText, jsonValue } from "./json-text";

export type VisualReviewRow = {
  question_id: string;
  item_id: string;
  check_id: string;
  evidence_ids: string;
  created_at: number;
  kind: string;
  outcome: string | null;
  answered_by: string | null;
  answered_at: number | null;
  feedback: string | null;
  head_commit: string | null;
  carried: string | null;
};

export type NewVisualReviewRow = {
  questionId: string;
  itemId: string;
  checkId: string;
  evidenceIds: readonly string[];
  createdAt: number;
  kind?: string;
  headCommit?: string | null;
  carried?: unknown;
  outcome?: string;
  answeredBy?: string;
  answeredAt?: number;
};

function rowColumns(q: Q) {
  const v = q.t.visualReview;
  return {
    question_id: v.questionId,
    item_id: v.itemId,
    check_id: v.checkId,
    evidence_ids: jsonText(q, v.evidenceIds),
    created_at: v.createdAt,
    kind: v.kind,
    outcome: v.outcome,
    answered_by: v.answeredBy,
    answered_at: v.answeredAt,
    feedback: v.feedback,
    head_commit: v.headCommit,
    carried: jsonText(q, v.carried) as SQL<string | null>,
  };
}

function answeredFirst(q: Q, direction: "ASC" | "DESC"): SQL[] {
  const v = q.t.visualReview;
  const nulls = direction === "ASC" ? sql`NULLS FIRST` : sql`NULLS LAST`;
  return [
    sql`${v.answeredAt} ${sql.raw(direction)} ${nulls}`,
    sql`${v.createdAt} ${sql.raw(direction)}`,
    sql`${v.questionId} ${sql.raw(direction)}`,
  ];
}

export function* insertVisualReviewRowSteps(q: Q, row: NewVisualReviewRow) {
  yield* q.exec(
    q.orm.insert(q.t.visualReview).values({
      questionId: row.questionId,
      itemId: row.itemId,
      checkId: row.checkId,
      evidenceIds: jsonValue(q, row.evidenceIds),
      createdAt: row.createdAt,
      ...(row.kind === undefined ? {} : { kind: row.kind }),
      headCommit: row.headCommit ?? null,
      carried: row.carried === undefined ? null : jsonValue(q, row.carried),
      ...(row.outcome === undefined
        ? {}
        : { outcome: row.outcome, answeredBy: row.answeredBy, answeredAt: row.answeredAt }),
    }),
  );
}

export async function insertVisualReviewRow(store: Db, row: NewVisualReviewRow): Promise<void> {
  await store.run((q) => insertVisualReviewRowSteps(q, row));
}

export function* visualReviewRowSteps(
  q: Q,
  questionId: string,
): Steps<VisualReviewRow | undefined> {
  const v = q.t.visualReview;
  return (yield* q.one(q.orm.select(rowColumns(q)).from(v).where(eq(v.questionId, questionId)))) as
    | VisualReviewRow
    | undefined;
}

export async function visualReviewRow(
  store: Db,
  questionId: string,
): Promise<VisualReviewRow | undefined> {
  return store.run((q) => visualReviewRowSteps(q, questionId));
}

export function* approvedVisualReviewRowsSteps(
  q: Q,
  itemId: string,
  checkId: string,
): Steps<VisualReviewRow[]> {
  const v = q.t.visualReview;
  return (yield* q.all(
    q.orm
      .select(rowColumns(q))
      .from(v)
      .where(
        and(
          eq(v.itemId, itemId),
          eq(v.checkId, checkId),
          eq(v.kind, "review"),
          inArray(v.outcome, ["accepted", "stale"]),
          isNotNull(v.answeredBy),
        ),
      )
      .orderBy(...answeredFirst(q, "ASC")),
  )) as VisualReviewRow[];
}

export async function approvedVisualReviewRows(
  store: Db,
  itemId: string,
  checkId: string,
): Promise<VisualReviewRow[]> {
  return store.run((q) => approvedVisualReviewRowsSteps(q, itemId, checkId));
}

export function* recordVisualReviewAnswerRowSteps(
  q: Q,
  questionId: string,
  answer: {
    outcome: string;
    answeredBy: string;
    now: number;
    feedback?: string;
    headCommit?: string;
  },
) {
  const v = q.t.visualReview;
  yield* q.exec(
    q.orm
      .update(v)
      .set({
        outcome: answer.outcome,
        answeredBy: answer.answeredBy,
        answeredAt: answer.now,
        feedback: answer.feedback ?? null,
        headCommit: answer.headCommit ?? null,
      })
      .where(eq(v.questionId, questionId)),
  );
}

export async function recordVisualReviewAnswerRow(
  store: Db,
  questionId: string,
  answer: {
    outcome: string;
    answeredBy: string;
    now: number;
    feedback?: string;
    headCommit?: string;
  },
): Promise<void> {
  await store.run((q) => recordVisualReviewAnswerRowSteps(q, questionId, answer));
}

export function* markVisualReviewRowStaleSteps(q: Q, questionId: string) {
  const v = q.t.visualReview;
  yield* q.exec(
    q.orm
      .update(v)
      .set({ outcome: "stale" })
      .where(and(eq(v.questionId, questionId), eq(v.outcome, "accepted"))),
  );
}

export async function markVisualReviewRowStale(store: Db, questionId: string): Promise<void> {
  await store.run((q) => markVisualReviewRowStaleSteps(q, questionId));
}

export function* itemVisualReviewRowsSteps(
  q: Q,
  itemId: string,
  outcomes: readonly string[],
  reviewsOnly: boolean,
): Steps<VisualReviewRow[]> {
  const v = q.t.visualReview;
  return (yield* q.all(
    q.orm
      .select(rowColumns(q))
      .from(v)
      .where(
        and(
          eq(v.itemId, itemId),
          inArray(v.outcome, [...outcomes]),
          reviewsOnly ? eq(v.kind, "review") : undefined,
        ),
      )
      .orderBy(...answeredFirst(q, "ASC")),
  )) as VisualReviewRow[];
}

export async function itemVisualReviewRows(
  store: Db,
  itemId: string,
  outcomes: readonly string[],
  reviewsOnly: boolean,
): Promise<VisualReviewRow[]> {
  return store.run((q) => itemVisualReviewRowsSteps(q, itemId, outcomes, reviewsOnly));
}

export function* visualReviewRoundCountsSteps(q: Q, itemId: string, checkId: string) {
  const v = q.t.visualReview;
  const rows = yield* q.all(
    q.orm
      .select({ kind: v.kind, outcome: v.outcome })
      .from(v)
      .where(and(eq(v.itemId, itemId), eq(v.checkId, checkId))),
  );
  return {
    changes: rows.filter((row) => row.kind === "review" && row.outcome === "changes_requested")
      .length,
    continued: rows.filter((row) => row.kind === "continue" && row.outcome === "continued").length,
  };
}

export async function visualReviewRoundCounts(
  store: Db,
  itemId: string,
  checkId: string,
): Promise<{ changes: number; continued: number }> {
  return store.run((q) => visualReviewRoundCountsSteps(q, itemId, checkId));
}

export function* lastVisualReviewFeedbackRowSteps(q: Q, itemId: string, checkId: string) {
  const v = q.t.visualReview;
  const row = yield* q.one(
    q.orm
      .select({ questionId: v.questionId, feedback: v.feedback })
      .from(v)
      .where(
        and(
          eq(v.itemId, itemId),
          eq(v.checkId, checkId),
          eq(v.kind, "review"),
          eq(v.outcome, "changes_requested"),
        ),
      )
      .orderBy(...answeredFirst(q, "DESC"))
      .limit(1),
  );
  return row ?? null;
}

export async function lastVisualReviewFeedbackRow(
  store: Db,
  itemId: string,
  checkId: string,
): Promise<{ questionId: string; feedback: string | null } | null> {
  return store.run((q) => lastVisualReviewFeedbackRowSteps(q, itemId, checkId));
}
