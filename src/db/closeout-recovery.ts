import type { Database } from "bun:sqlite";
import { asc, eq, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { jsonText, jsonValue } from "./json-text";
import { orm } from "./orm";
import { closeoutRecovery, question } from "./schema";

export type CloseoutRecovery = {
  questionId: string;
  taskId: string;
  itemId: string;
  base: string;
  head: string;
  policyDigest: string;
  failedChecks: string[];
  retryBaseline: string[];
  summary: string;
  answer: string | null;
  answeredBy: string | null;
};

export function* saveCloseoutRecoverySteps(
  q: Q,
  input: Omit<CloseoutRecovery, "answer" | "answeredBy">,
) {
  yield* q.exec(
    q.orm.insert(q.t.closeoutRecovery).values({
      ...input,
      failedChecks: jsonValue(q, input.failedChecks),
      retryBaseline: jsonValue(q, input.retryBaseline),
    }),
  );
}

export function saveCloseoutRecovery(
  db: Database,
  input: Omit<CloseoutRecovery, "answer" | "answeredBy">,
): void {
  orm(db)
    .insert(closeoutRecovery)
    .values({
      ...input,
      failedChecks: JSON.stringify(input.failedChecks),
      retryBaseline: JSON.stringify(input.retryBaseline),
    })
    .run();
}

export function* listCloseoutRecoveriesSteps(q: Q, itemId: string): Steps<CloseoutRecovery[]> {
  const { closeoutRecovery: recovery, question: asked } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        questionId: recovery.questionId,
        taskId: recovery.taskId,
        itemId: recovery.itemId,
        base: recovery.base,
        head: recovery.head,
        policyDigest: recovery.policyDigest,
        failedChecks: jsonText(q, recovery.failedChecks),
        retryBaseline: jsonText(q, recovery.retryBaseline),
        summary: recovery.summary,
        answer: asked.answer,
        answeredBy: asked.answeredBy,
      })
      .from(recovery)
      .innerJoin(asked, eq(asked.id, recovery.questionId))
      .where(eq(recovery.itemId, itemId))
      .orderBy(asc(asked.createdAt), q.dialect === "sqlite" ? sql`question.rowid` : asc(asked.id)),
  );
  return rows.map((row) => ({
    ...row,
    failedChecks: JSON.parse(row.failedChecks) as string[],
    retryBaseline: JSON.parse(row.retryBaseline) as string[],
  }));
}

export function listCloseoutRecoveries(db: Database, itemId: string): CloseoutRecovery[] {
  return orm(db)
    .select({ row: closeoutRecovery, answer: question.answer, answeredBy: question.answeredBy })
    .from(closeoutRecovery)
    .innerJoin(question, eq(question.id, closeoutRecovery.questionId))
    .where(eq(closeoutRecovery.itemId, itemId))
    .orderBy(question.createdAt, sql`question.rowid`)
    .all()
    .map(({ row, answer, answeredBy }) => ({
      questionId: row.questionId,
      taskId: row.taskId,
      itemId: row.itemId,
      base: row.base,
      head: row.head,
      policyDigest: row.policyDigest,
      failedChecks: JSON.parse(row.failedChecks) as string[],
      retryBaseline: JSON.parse(row.retryBaseline) as string[],
      summary: row.summary,
      answer,
      answeredBy,
    }));
}

/** The candidate a Closeout help question was asked about, by its question. */
export function* getCloseoutRecoverySteps(q: Q, questionId: string) {
  const { closeoutRecovery: r } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        head: r.head,
        policyDigest: r.policyDigest,
        failedChecks: jsonText(q, r.failedChecks),
      })
      .from(r)
      .where(eq(r.questionId, questionId)),
  );
  return row === undefined
    ? null
    : { ...row, failedChecks: JSON.parse(row.failedChecks) as string[] };
}

export function getCloseoutRecovery(
  db: Database,
  questionId: string,
): Pick<CloseoutRecovery, "head" | "policyDigest" | "failedChecks"> | null {
  return settled(sqliteDb(db).run((q) => getCloseoutRecoverySteps(q, questionId)));
}
