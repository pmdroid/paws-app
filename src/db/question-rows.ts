import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps, type Db } from "./db";
import { jsonText, jsonValue } from "./json-text";

export type QuestionRow = {
  id: string;
  itemId: string;
  runId: string | null;
  sessionId: string;
  kind: string;
  reason: string | null;
  body: string;
  context: string | null;
  options: string | null;
  status: string;
  answer: string | null;
  answeredBy: string | null;
  answerEventKey: string | null;
  createdAt: number;
  answeredAt: number | null;
  cancelledAt: number | null;
};

function questionColumns(q: Q) {
  const { question } = q.t;
  return {
    id: question.id,
    itemId: question.itemId,
    runId: question.runId,
    sessionId: question.sessionId,
    kind: question.kind,
    reason: question.reason,
    body: question.body,
    context: question.context,
    options: jsonText(q, question.options) as SQL<string | null>,
    status: question.status,
    answer: question.answer,
    answeredBy: question.answeredBy,
    answerEventKey: question.answerEventKey,
    createdAt: question.createdAt,
    answeredAt: question.answeredAt,
    cancelledAt: question.cancelledAt,
  };
}

export type NewQuestionRow = {
  id: string;
  itemId: string;
  runId: string | null;
  sessionId: string;
  kind: string;
  reason: string;
  body: string;
  context: string | null;
  options: readonly unknown[] | null;
  status: "queued" | "open";
  createdAt: number;
};

export function* insertQuestionRowSteps(q: Q, row: NewQuestionRow) {
  yield* q.exec(
    q.orm
      .insert(q.t.question)
      .values({ ...row, options: row.options === null ? null : jsonValue(q, row.options) }),
  );
}

export async function insertQuestionRow(store: Db, row: NewQuestionRow): Promise<void> {
  await store.run((q) => insertQuestionRowSteps(q, row));
}

export function* questionRowByIdSteps(q: Q, id: string): Steps<QuestionRow | null> {
  const { question } = q.t;
  const row = yield* q.one(
    q.orm.select(questionColumns(q)).from(question).where(eq(question.id, id)),
  );
  return row ?? null;
}

export async function questionRowById(store: Db, id: string): Promise<QuestionRow | null> {
  return store.run((q) => questionRowByIdSteps(q, id));
}

export function* openQuestionRowSteps(q: Q, sessionId: string): Steps<QuestionRow | null> {
  const { question } = q.t;
  const row = yield* q.one(
    q.orm
      .select(questionColumns(q))
      .from(question)
      .where(
        and(
          eq(question.sessionId, sessionId),
          eq(question.status, "open"),
          isNull(question.cancelledAt),
        ),
      )
      .orderBy(desc(question.createdAt), desc(question.id))
      .limit(1),
  );
  return row ?? null;
}

export async function openQuestionRow(store: Db, sessionId: string): Promise<QuestionRow | null> {
  return store.run((q) => openQuestionRowSteps(q, sessionId));
}

export function* askedQuestionRowSteps(
  q: Q,
  runId: string,
  kind: string,
): Steps<QuestionRow | null> {
  const { question } = q.t;
  const row = yield* q.one(
    q.orm
      .select(questionColumns(q))
      .from(question)
      .where(
        and(
          eq(question.runId, runId),
          eq(question.kind, kind),
          inArray(question.status, ["open", "queued"]),
          isNull(question.cancelledAt),
        ),
      )
      .orderBy(desc(question.createdAt), desc(question.id))
      .limit(1),
  );
  return row ?? null;
}

export function askedQuestionRow(db: Database, runId: string, kind: string): QuestionRow | null {
  return settled(sqliteDb(db).run((q) => askedQuestionRowSteps(q, runId, kind)));
}

export function* nextQueuedQuestionRowSteps(q: Q, sessionId: string): Steps<QuestionRow | null> {
  const { question } = q.t;
  const row = yield* q.one(
    q.orm
      .select(questionColumns(q))
      .from(question)
      .where(
        and(
          eq(question.sessionId, sessionId),
          eq(question.status, "queued"),
          isNull(question.cancelledAt),
        ),
      )
      .orderBy(asc(question.createdAt), q.dialect === "sqlite" ? sql`rowid` : asc(question.id))
      .limit(1),
  );
  return row ?? null;
}

export async function nextQueuedQuestionRow(
  store: Db,
  sessionId: string,
): Promise<QuestionRow | null> {
  return store.run((q) => nextQueuedQuestionRowSteps(q, sessionId));
}

export function* questionEventConsumedSteps(q: Q, sessionId: string, eventKey: string) {
  const { question } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: question.id })
      .from(question)
      .where(and(eq(question.sessionId, sessionId), eq(question.answerEventKey, eventKey))),
  );
  return row !== undefined;
}

export async function questionEventConsumed(
  store: Db,
  sessionId: string,
  eventKey: string,
): Promise<boolean> {
  return store.run((q) => questionEventConsumedSteps(q, sessionId, eventKey));
}

type QueuedScope = { itemId: string } | { sessionId: string };

export function* cancelQueuedQuestionsSteps(q: Q, scope: QueuedScope, kind: string, now: number) {
  const { question } = q.t;
  yield* q.exec(
    q.orm
      .update(question)
      .set({ cancelledAt: now })
      .where(
        and(
          "itemId" in scope
            ? eq(question.itemId, scope.itemId)
            : eq(question.sessionId, scope.sessionId),
          eq(question.kind, kind),
          eq(question.status, "queued"),
          isNull(question.cancelledAt),
        ),
      ),
  );
}

export async function cancelQueuedQuestions(
  store: Db,
  scope: QueuedScope,
  kind: string,
  now: number,
): Promise<void> {
  await store.run((q) => cancelQueuedQuestionsSteps(q, scope, kind, now));
}

export function* amendQuestionRowSteps(
  q: Q,
  id: string,
  amended: { context: string; options: readonly unknown[] },
) {
  const { question } = q.t;
  yield* q.exec(
    q.orm
      .update(question)
      .set({ context: amended.context, options: jsonValue(q, amended.options) })
      .where(eq(question.id, id)),
  );
}

export async function amendQuestionRow(
  store: Db,
  id: string,
  amended: { context: string; options: readonly unknown[] },
): Promise<void> {
  await store.run((q) => amendQuestionRowSteps(q, id, amended));
}

type QuestionAnswerRow = {
  answer: string;
  answeredBy: string;
  answeredAt: number;
  answerEventKey: string | null;
};

export function* markQuestionAnsweredSteps(q: Q, id: string, answer: QuestionAnswerRow) {
  const { question } = q.t;
  const updated = yield* q.all(
    q.orm
      .update(question)
      .set({ status: "answered", ...answer })
      .where(and(eq(question.id, id), eq(question.status, "open"), isNull(question.cancelledAt)))
      .returning({ id: question.id }),
  );
  return updated.length > 0;
}

export async function markQuestionAnswered(
  store: Db,
  id: string,
  answer: QuestionAnswerRow,
): Promise<boolean> {
  return store.run((q) => markQuestionAnsweredSteps(q, id, answer));
}

export function* setQuestionCancelledSteps(q: Q, id: string, now: number) {
  const { question } = q.t;
  yield* q.exec(q.orm.update(question).set({ cancelledAt: now }).where(eq(question.id, id)));
}

export async function setQuestionCancelled(store: Db, id: string, now: number): Promise<void> {
  await store.run((q) => setQuestionCancelledSteps(q, id, now));
}

export function* promoteQuestionRowSteps(q: Q, id: string, now: number) {
  const { question } = q.t;
  yield* q.exec(
    q.orm.update(question).set({ status: "open", createdAt: now }).where(eq(question.id, id)),
  );
}

export async function promoteQuestionRow(store: Db, id: string, now: number): Promise<void> {
  await store.run((q) => promoteQuestionRowSteps(q, id, now));
}

export type ActiveItemQuestion = { id: string; kind: string; sessionId: string };

export function* activeItemQuestionsSteps(q: Q, itemId: string): Steps<ActiveItemQuestion[]> {
  const { question } = q.t;
  return yield* q.all(
    q.orm
      .select({ id: question.id, kind: question.kind, sessionId: question.sessionId })
      .from(question)
      .where(
        and(
          eq(question.itemId, itemId),
          inArray(question.status, ["open", "queued"]),
          isNull(question.cancelledAt),
        ),
      ),
  );
}

export async function activeItemQuestions(
  store: Db,
  itemId: string,
): Promise<ActiveItemQuestion[]> {
  return store.run((q) => activeItemQuestionsSteps(q, itemId));
}
