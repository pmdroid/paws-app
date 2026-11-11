import { asc, eq, sql } from "drizzle-orm";
import { type Q, type Steps, type Db } from "./db";
import { jsonText, jsonValue } from "./json-text";

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

export async function saveCloseoutRecovery(
  store: Db,
  input: Omit<CloseoutRecovery, "answer" | "answeredBy">,
): Promise<void> {
  await store.run((q) => saveCloseoutRecoverySteps(q, input));
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

export async function listCloseoutRecoveries(
  store: Db,
  itemId: string,
): Promise<CloseoutRecovery[]> {
  return store.run((q) => listCloseoutRecoveriesSteps(q, itemId));
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

export async function getCloseoutRecovery(
  store: Db,
  questionId: string,
): Promise<Pick<CloseoutRecovery, "head" | "policyDigest" | "failedChecks"> | null> {
  return store.run((q) => getCloseoutRecoverySteps(q, questionId));
}
