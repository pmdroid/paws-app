import type { Database } from "bun:sqlite";
import { and, eq, isNull } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import type * as pg from "./schema-pg";

export type PolicyBlock = {
  questionId: string;
  itemId: string;
  repository: string;
  cause: "policy_unreadable";
  error: string;
  policyPath: string;
  main: string;
  changedBy: string | null;
  createdAt: number;
};

const map = (row: typeof pg.closeoutPolicyBlock.$inferSelect): PolicyBlock => ({
  questionId: row.questionId,
  itemId: row.itemId,
  repository: row.repository,
  cause: row.cause as PolicyBlock["cause"],
  error: row.error,
  policyPath: row.policyPath,
  main: row.mainSha,
  changedBy: row.changedBySha,
  createdAt: row.createdAt,
});

export function* savePolicyBlockSteps(q: Q, block: PolicyBlock) {
  const { closeoutPolicyBlock } = q.t;
  const values = {
    itemId: block.itemId,
    repository: block.repository,
    cause: block.cause,
    error: block.error,
    policyPath: block.policyPath,
    mainSha: block.main,
    changedBySha: block.changedBy,
    createdAt: block.createdAt,
  };
  yield* q.exec(
    q.orm
      .insert(closeoutPolicyBlock)
      .values({ questionId: block.questionId, ...values })
      .onConflictDoUpdate({ target: closeoutPolicyBlock.questionId, set: values }),
  );
}

export function savePolicyBlock(db: Database, block: PolicyBlock): void {
  settled(sqliteDb(db).run((q) => savePolicyBlockSteps(q, block)));
}

/** Oldest first; blocks created in the same millisecond in item order. */
export function* listOpenPolicyBlocksSteps(q: Q, repository?: string): Steps<PolicyBlock[]> {
  const { closeoutPolicyBlock, question } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ block: closeoutPolicyBlock })
      .from(closeoutPolicyBlock)
      .innerJoin(question, eq(question.id, closeoutPolicyBlock.questionId))
      .where(
        and(
          eq(question.status, "open"),
          isNull(question.cancelledAt),
          repository === undefined ? undefined : eq(closeoutPolicyBlock.repository, repository),
        ),
      )
      .orderBy(
        closeoutPolicyBlock.createdAt,
        closeoutPolicyBlock.itemId,
        closeoutPolicyBlock.questionId,
      ),
  );
  return rows.map(({ block }) => map(block));
}

export function listOpenPolicyBlocks(db: Database, repository?: string): PolicyBlock[] {
  return settled(sqliteDb(db).run((q) => listOpenPolicyBlocksSteps(q, repository)));
}
