import type { Database } from "bun:sqlite";
import { asc, eq } from "drizzle-orm";
import { orm } from "./orm";
import { closeoutPolicyOutage } from "./schema";

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

const columns = {
  repository: closeoutPolicyOutage.repository,
  startedAt: closeoutPolicyOutage.startedAt,
  error: closeoutPolicyOutage.error,
  policyPath: closeoutPolicyOutage.policyPath,
  main: closeoutPolicyOutage.mainSha,
  changedBy: closeoutPolicyOutage.changedBySha,
  questionId: closeoutPolicyOutage.questionId,
  questionItemId: closeoutPolicyOutage.questionItemId,
};

export function getPolicyOutage(db: Database, repository: string): PolicyOutage | null {
  return (
    orm(db)
      .select(columns)
      .from(closeoutPolicyOutage)
      .where(eq(closeoutPolicyOutage.repository, repository))
      .get() ?? null
  );
}

export function listPolicyOutages(db: Database): PolicyOutage[] {
  return orm(db)
    .select(columns)
    .from(closeoutPolicyOutage)
    .orderBy(asc(closeoutPolicyOutage.startedAt), asc(closeoutPolicyOutage.repository))
    .all();
}

export function recordPolicyOutage(
  db: Database,
  input: {
    repository: string;
    error: string;
    policyPath: string;
    main: string;
    changedBy: string | null;
    now: number;
  },
): PolicyOutage {
  const current = getPolicyOutage(db, input.repository);
  if (current && current.error === input.error && current.changedBy === input.changedBy) {
    orm(db)
      .update(closeoutPolicyOutage)
      .set({ mainSha: input.main })
      .where(eq(closeoutPolicyOutage.repository, input.repository))
      .run();
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
    orm(db)
      .insert(closeoutPolicyOutage)
      .values(row)
      .onConflictDoUpdate({ target: closeoutPolicyOutage.repository, set: row })
      .run();
  }
  return getPolicyOutage(db, input.repository)!;
}

export function setPolicyOutageQuestion(
  db: Database,
  repository: string,
  question: { id: string; itemId: string } | null,
): void {
  orm(db)
    .update(closeoutPolicyOutage)
    .set({ questionId: question?.id ?? null, questionItemId: question?.itemId ?? null })
    .where(eq(closeoutPolicyOutage.repository, repository))
    .run();
}

export function endPolicyOutage(db: Database, repository: string): PolicyOutage | null {
  const current = getPolicyOutage(db, repository);
  if (current) {
    orm(db)
      .delete(closeoutPolicyOutage)
      .where(eq(closeoutPolicyOutage.repository, repository))
      .run();
  }
  return current;
}
