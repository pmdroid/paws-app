import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
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
export function getCloseoutRecovery(
  db: Database,
  questionId: string,
): Pick<CloseoutRecovery, "head" | "policyDigest" | "failedChecks"> | null {
  const row = orm(db)
    .select({
      head: closeoutRecovery.head,
      policyDigest: closeoutRecovery.policyDigest,
      failedChecks: closeoutRecovery.failedChecks,
    })
    .from(closeoutRecovery)
    .where(eq(closeoutRecovery.questionId, questionId))
    .get();
  return row === undefined
    ? null
    : { ...row, failedChecks: JSON.parse(row.failedChecks) as string[] };
}
