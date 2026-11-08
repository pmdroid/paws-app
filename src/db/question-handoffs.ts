import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull, notInArray, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import { jsonText } from "./json-text";

/** Record the item version that carried the question's answer back; 0 means none will. */
export function* setQuestionHandoffVersionSteps(q: Q, questionId: string, version: number) {
  const { question } = q.t;
  yield* q.exec(
    q.orm.update(question).set({ handoffVersion: version }).where(eq(question.id, questionId)),
  );
}

export function setQuestionHandoffVersion(db: Database, questionId: string, version: number): void {
  settled(sqliteDb(db).run((q) => setQuestionHandoffVersionSteps(q, questionId, version)));
}

/** Store the answer to a retry question, which no agent turn will read. */
export function* setRetryAnswerSteps(q: Q, questionId: string, answer: string) {
  const { question } = q.t;
  yield* q.exec(
    q.orm.update(question).set({ answer, handoffVersion: 0 }).where(eq(question.id, questionId)),
  );
}

export function setRetryAnswer(db: Database, questionId: string, answer: string): void {
  settled(sqliteDb(db).run((q) => setRetryAnswerSteps(q, questionId, answer)));
}

/** Answered questions on this session no turn has received yet, oldest answer first. */
export function* pendingAnswerHandoffsSteps(
  q: Q,
  itemId: string,
  sessionId: string,
  excludedKinds: readonly string[],
) {
  const { question } = q.t;
  return yield* q.all(
    q.orm
      .select({
        id: question.id,
        body: question.body,
        options: jsonText(q, question.options),
        answer: question.answer,
      })
      .from(question)
      .where(
        and(
          eq(question.itemId, itemId),
          eq(question.sessionId, sessionId),
          eq(question.status, "answered"),
          isNull(question.cancelledAt),
          isNull(question.handoffVersion),
          notInArray(question.kind, [...excludedKinds]),
        ),
      )
      .orderBy(asc(question.answeredAt), q.dialect === "sqlite" ? sql`rowid` : asc(question.id)),
  );
}

export function pendingAnswerHandoffs(
  db: Database,
  itemId: string,
  sessionId: string,
  excludedKinds: readonly string[],
): { id: string; body: string; options: string | null; answer: string }[] {
  return settled(
    sqliteDb(db).run((q) => pendingAnswerHandoffsSteps(q, itemId, sessionId, excludedKinds)),
  ) as { id: string; body: string; options: string | null; answer: string }[];
}

/** Whether `ask()` recorded this question and it still waits for an answer on the session. */
export function* askedQuestionOpenSteps(q: Q, sessionId: string, questionId: string) {
  const { question, workItemEvent } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(workItemEvent)
      .innerJoin(question, eq(question.id, workItemEvent.payloadDigest))
      .where(
        and(
          eq(workItemEvent.kind, "ask"),
          eq(question.sessionId, sessionId),
          eq(question.id, questionId),
          isNull(question.cancelledAt),
          eq(question.status, "open"),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export function askedQuestionOpen(db: Database, sessionId: string, questionId: string): boolean {
  return settled(sqliteDb(db).run((q) => askedQuestionOpenSteps(q, sessionId, questionId)));
}
