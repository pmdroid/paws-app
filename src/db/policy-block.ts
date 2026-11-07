import type { Database } from "bun:sqlite";
import { and, eq, isNull, sql } from "drizzle-orm";
import { orm } from "./orm";
import { closeoutPolicyBlock, question } from "./schema";

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

const map = (row: typeof closeoutPolicyBlock.$inferSelect): PolicyBlock => ({
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

export function savePolicyBlock(db: Database, block: PolicyBlock): void {
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
  orm(db)
    .insert(closeoutPolicyBlock)
    .values({ questionId: block.questionId, ...values })
    .onConflictDoUpdate({ target: closeoutPolicyBlock.questionId, set: values })
    .run();
}

export function listOpenPolicyBlocks(db: Database, repository?: string): PolicyBlock[] {
  return orm(db)
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
    .orderBy(closeoutPolicyBlock.createdAt, sql`closeout_policy_block.rowid`)
    .all()
    .map(({ block }) => map(block));
}
