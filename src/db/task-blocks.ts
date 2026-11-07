import type { Database } from "bun:sqlite";
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
      db.run(
        `DELETE FROM task_block WHERE blocked_linear_issue_id IN (${blockedLinearIssueIds.map(() => "?").join(",")})`,
        [...blockedLinearIssueIds],
      );
    }
    for (const edge of edges) {
      db.run(
        `INSERT INTO task_block(blocker_linear_issue_id,blocked_linear_issue_id) VALUES(?,?) ON CONFLICT DO NOTHING`,
        [edge.blockerLinearIssueId, edge.blockedLinearIssueId],
      );
    }
  });
}

export function listTaskBlockers(db: Database, blockedLinearIssueId: string): string[] {
  return db
    .query<{ blocker_linear_issue_id: string }, [string]>(
      "SELECT blocker_linear_issue_id FROM task_block WHERE blocked_linear_issue_id = ? ORDER BY blocker_linear_issue_id",
    )
    .all(blockedLinearIssueId)
    .map((row) => row.blocker_linear_issue_id);
}

export function listTaskBlocks(db: Database): { blocker: string; blocked: string }[] {
  return orm(db)
    .select({ blocker: taskBlock.blockerLinearIssueId, blocked: taskBlock.blockedLinearIssueId })
    .from(taskBlock)
    .all();
}
