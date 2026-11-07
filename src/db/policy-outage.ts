import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";

export type PolicyOutage = {
  repository: string;
  startedAt: number;
  error: string;
  policyPath: string;
  main: string;
  changedBy: string | null;
  questionId: string | null;
  questionItemId: string | null;
};

function columns(q: Q) {
  const outage = q.t.closeoutPolicyOutage;
  return {
    repository: outage.repository,
    startedAt: outage.startedAt,
    error: outage.error,
    policyPath: outage.policyPath,
    main: outage.mainSha,
    changedBy: outage.changedBySha,
    questionId: outage.questionId,
    questionItemId: outage.questionItemId,
  };
}

export function* getPolicyOutageSteps(q: Q, repository: string): Steps<PolicyOutage | null> {
  const outage = q.t.closeoutPolicyOutage;
  return (
    (yield* q.one(
      q.orm.select(columns(q)).from(outage).where(eq(outage.repository, repository)),
    )) ?? null
  );
}

export function getPolicyOutage(db: Database, repository: string): PolicyOutage | null {
  return settled(sqliteDb(db).run((q) => getPolicyOutageSteps(q, repository)));
}

type PolicyOutageInput = {
  repository: string;
  error: string;
  policyPath: string;
  main: string;
  changedBy: string | null;
  now: number;
};

export function* recordPolicyOutageSteps(q: Q, input: PolicyOutageInput): Steps<PolicyOutage> {
  const outage = q.t.closeoutPolicyOutage;
  const current = yield* getPolicyOutageSteps(q, input.repository);
  if (current && current.error === input.error && current.changedBy === input.changedBy) {
    yield* q.exec(
      q.orm
        .update(outage)
        .set({ mainSha: input.main })
        .where(eq(outage.repository, input.repository)),
    );
  } else {
    const row = {
      repository: input.repository,
      startedAt: input.now,
      error: input.error,
      policyPath: input.policyPath,
      mainSha: input.main,
      changedBySha: input.changedBy,
      questionId: null,
      questionItemId: null,
    };
    yield* q.exec(
      q.orm.insert(outage).values(row).onConflictDoUpdate({ target: outage.repository, set: row }),
    );
  }
  return (yield* getPolicyOutageSteps(q, input.repository))!;
}

export function recordPolicyOutage(db: Database, input: PolicyOutageInput): PolicyOutage {
  return settled(sqliteDb(db).run((q) => recordPolicyOutageSteps(q, input)));
}

export function* setPolicyOutageQuestionSteps(
  q: Q,
  repository: string,
  question: { id: string; itemId: string } | null,
) {
  const outage = q.t.closeoutPolicyOutage;
  yield* q.exec(
    q.orm
      .update(outage)
      .set({ questionId: question?.id ?? null, questionItemId: question?.itemId ?? null })
      .where(eq(outage.repository, repository)),
  );
}

export function setPolicyOutageQuestion(
  db: Database,
  repository: string,
  question: { id: string; itemId: string } | null,
): void {
  settled(sqliteDb(db).run((q) => setPolicyOutageQuestionSteps(q, repository, question)));
}

export function* endPolicyOutageSteps(q: Q, repository: string): Steps<PolicyOutage | null> {
  const outage = q.t.closeoutPolicyOutage;
  const current = yield* getPolicyOutageSteps(q, repository);
  if (current) yield* q.exec(q.orm.delete(outage).where(eq(outage.repository, repository)));
  return current;
}

export function endPolicyOutage(db: Database, repository: string): PolicyOutage | null {
  return settled(sqliteDb(db).run((q) => endPolicyOutageSteps(q, repository)));
}
