import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";
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

export function insertQuestionRow(db: Database, row: NewQuestionRow): void {
  settled(sqliteDb(db).run((q) => insertQuestionRowSteps(q, row)));
}

export function* questionRowByIdSteps(q: Q, id: string): Steps<QuestionRow | null> {
  const { question } = q.t;
  const row = yield* q.one(
    q.orm.select(questionColumns(q)).from(question).where(eq(question.id, id)),
  );
  return row ?? null;
}

export function questionRowById(db: Database, id: string): QuestionRow | null {
  return settled(sqliteDb(db).run((q) => questionRowByIdSteps(q, id)));
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

export function openQuestionRow(db: Database, sessionId: string): QuestionRow | null {
  return settled(sqliteDb(db).run((q) => openQuestionRowSteps(q, sessionId)));
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

export function nextQueuedQuestionRow(db: Database, sessionId: string): QuestionRow | null {
  return settled(sqliteDb(db).run((q) => nextQueuedQuestionRowSteps(q, sessionId)));
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

export function questionEventConsumed(db: Database, sessionId: string, eventKey: string): boolean {
  return settled(sqliteDb(db).run((q) => questionEventConsumedSteps(q, sessionId, eventKey)));
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

export function cancelQueuedQuestions(
  db: Database,
  scope: QueuedScope,
  kind: string,
  now: number,
): void {
  settled(sqliteDb(db).run((q) => cancelQueuedQuestionsSteps(q, scope, kind, now)));
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

export function amendQuestionRow(
  db: Database,
  id: string,
  amended: { context: string; options: readonly unknown[] },
): void {
  settled(sqliteDb(db).run((q) => amendQuestionRowSteps(q, id, amended)));
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

export function markQuestionAnswered(db: Database, id: string, answer: QuestionAnswerRow): boolean {
  return settled(sqliteDb(db).run((q) => markQuestionAnsweredSteps(q, id, answer)));
}

export function* setQuestionCancelledSteps(q: Q, id: string, now: number) {
  const { question } = q.t;
  yield* q.exec(q.orm.update(question).set({ cancelledAt: now }).where(eq(question.id, id)));
}

export function setQuestionCancelled(db: Database, id: string, now: number): void {
  settled(sqliteDb(db).run((q) => setQuestionCancelledSteps(q, id, now)));
}

export function* promoteQuestionRowSteps(q: Q, id: string, now: number) {
  const { question } = q.t;
  yield* q.exec(
    q.orm.update(question).set({ status: "open", createdAt: now }).where(eq(question.id, id)),
  );
}

export function promoteQuestionRow(db: Database, id: string, now: number): void {
  settled(sqliteDb(db).run((q) => promoteQuestionRowSteps(q, id, now)));
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

export function activeItemQuestions(db: Database, itemId: string): ActiveItemQuestion[] {
  return settled(sqliteDb(db).run((q) => activeItemQuestionsSteps(q, itemId)));
}
