import type { Database } from "bun:sqlite";
import { asc, eq, inArray } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

export type TaskBlock = {
  blockerLinearIssueId: string;
  blockedLinearIssueId: string;
};

export function* saveTaskBlocksSteps(
  q: Q,
  blockedLinearIssueIds: readonly string[],
  edges: readonly TaskBlock[],
) {
  const { taskBlock } = q.t;
  const allowed = new Set(blockedLinearIssueIds);
  for (const edge of edges) {
    if (!allowed.has(edge.blockedLinearIssueId)) {
      throw new Error(`blocked issue ${edge.blockedLinearIssueId} is outside the replaced set`);
    }
  }
  if (blockedLinearIssueIds.length > 0) {
    yield* q.exec(
      q.orm
        .delete(taskBlock)
        .where(inArray(taskBlock.blockedLinearIssueId, [...blockedLinearIssueIds])),
    );
  }
  for (const edge of edges) {
    yield* q.exec(
      q.orm
        .insert(taskBlock)
        .values({
          blockerLinearIssueId: edge.blockerLinearIssueId,
          blockedLinearIssueId: edge.blockedLinearIssueId,
        })
        .onConflictDoNothing(),
    );
  }
}

export function saveTaskBlocks(
  db: Database,
  blockedLinearIssueIds: readonly string[],
  edges: readonly TaskBlock[],
): void {
  settled(sqliteDb(db).transaction((q) => saveTaskBlocksSteps(q, blockedLinearIssueIds, edges)));
}

export function* listTaskBlockersSteps(q: Q, blockedLinearIssueId: string) {
  const { taskBlock } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ blocker: taskBlock.blockerLinearIssueId })
      .from(taskBlock)
      .where(eq(taskBlock.blockedLinearIssueId, blockedLinearIssueId))
      .orderBy(asc(taskBlock.blockerLinearIssueId)),
  );
  return rows.map((row) => row.blocker);
}

export function listTaskBlockers(db: Database, blockedLinearIssueId: string): string[] {
  return settled(sqliteDb(db).run((q) => listTaskBlockersSteps(q, blockedLinearIssueId)));
}

export function* listTaskBlocksSteps(q: Q) {
  const { taskBlock } = q.t;
  return yield* q.all(
    q.orm
      .select({ blocker: taskBlock.blockerLinearIssueId, blocked: taskBlock.blockedLinearIssueId })
      .from(taskBlock),
  );
}

export function listTaskBlocks(db: Database): { blocker: string; blocked: string }[] {
  return settled(sqliteDb(db).run(listTaskBlocksSteps));
}
