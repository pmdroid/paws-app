import type { Database } from "bun:sqlite";
import { asc, eq, inArray } from "drizzle-orm";
import { orm } from "./orm";
import { taskBlock } from "./schema";
import { immediate } from "./tx";

export type TaskBlock = {
  blockerLinearIssueId: string;
  blockedLinearIssueId: string;
};

export function saveTaskBlocks(
  db: Database,
  blockedLinearIssueIds: readonly string[],
  edges: readonly TaskBlock[],
): void {
  immediate(db, () => {
    const allowed = new Set(blockedLinearIssueIds);
    for (const edge of edges) {
      if (!allowed.has(edge.blockedLinearIssueId)) {
        throw new Error(`blocked issue ${edge.blockedLinearIssueId} is outside the replaced set`);
      }
    }
    if (blockedLinearIssueIds.length > 0) {
      orm(db)
        .delete(taskBlock)
        .where(inArray(taskBlock.blockedLinearIssueId, [...blockedLinearIssueIds]))
        .run();
    }
    for (const edge of edges) {
      orm(db)
        .insert(taskBlock)
        .values({
          blockerLinearIssueId: edge.blockerLinearIssueId,
          blockedLinearIssueId: edge.blockedLinearIssueId,
        })
        .onConflictDoNothing()
        .run();
    }
  });
}

export function listTaskBlockers(db: Database, blockedLinearIssueId: string): string[] {
  return orm(db)
    .select({ blocker: taskBlock.blockerLinearIssueId })
    .from(taskBlock)
    .where(eq(taskBlock.blockedLinearIssueId, blockedLinearIssueId))
    .orderBy(asc(taskBlock.blockerLinearIssueId))
    .all()
    .map((row) => row.blocker);
}

export function listTaskBlocks(db: Database): { blocker: string; blocked: string }[] {
  return orm(db)
    .select({ blocker: taskBlock.blockerLinearIssueId, blocked: taskBlock.blockedLinearIssueId })
    .from(taskBlock)
    .all();
}
