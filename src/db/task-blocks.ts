import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, ne, notExists, notInArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { settled, sqliteDb, type Q } from "./db";
import { jsonText } from "./json-text";

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

export function* openTaskDependentsSteps(q: Q, delegationId: string, blockerLinearIssueId: string) {
  const { taskBlock, workItem } = q.t;
  return yield* q.all(
    q.orm
      .select({ id: workItem.id, identifier: workItem.linearIdentifier })
      .from(taskBlock)
      .innerJoin(
        workItem,
        and(
          eq(workItem.linearIssueId, taskBlock.blockedLinearIssueId),
          eq(workItem.delegationId, delegationId),
        ),
      )
      .where(
        and(
          eq(taskBlock.blockerLinearIssueId, blockerLinearIssueId),
          notInArray(workItem.state, ["merged", "completed", "cancelled"]),
        ),
      ),
  );
}

export function openTaskDependents(
  db: Database,
  delegationId: string,
  blockerLinearIssueId: string,
): { id: string; identifier: string }[] {
  return settled(
    sqliteDb(db).run((q) => openTaskDependentsSteps(q, delegationId, blockerLinearIssueId)),
  );
}

export function* landedTaskBlockersSteps(q: Q, delegationId: string, blockedLinearIssueId: string) {
  const { run, taskBlock, workItem, workItemSpecification } = q.t;
  const candidate = alias(workItem, "candidate");
  const latest = q.orm
    .select({ id: candidate.id })
    .from(candidate)
    .where(
      and(
        eq(candidate.linearIssueId, taskBlock.blockerLinearIssueId),
        eq(candidate.delegationId, delegationId),
        ne(candidate.state, "cancelled"),
        notExists(
          q.orm
            .select({ one: sql`1` })
            .from(workItemSpecification)
            .where(
              and(
                eq(workItemSpecification.itemId, candidate.id),
                eq(workItemSpecification.present, 0),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(candidate.createdAt), desc(candidate.id))
    .limit(1);
  const rows = yield* q.all(
    q.orm
      .select({
        id: workItem.id,
        identifier: workItem.linearIdentifier,
        checkpoint: jsonText(q, run.checkpoint),
      })
      .from(taskBlock)
      .innerJoin(workItem, sql`${workItem.id} = (${latest})`)
      .leftJoin(run, eq(run.id, workItem.currentRunId))
      .where(
        and(
          eq(taskBlock.blockedLinearIssueId, blockedLinearIssueId),
          inArray(workItem.state, ["merged", "completed"]),
        ),
      )
      .orderBy(asc(workItem.position), asc(workItem.id)),
  );
  return rows.map((row) => ({ ...row, checkpoint: row.checkpoint as string | null }));
}

export function landedTaskBlockers(
  db: Database,
  delegationId: string,
  blockedLinearIssueId: string,
): { id: string; identifier: string; checkpoint: string | null }[] {
  return settled(
    sqliteDb(db).run((q) => landedTaskBlockersSteps(q, delegationId, blockedLinearIssueId)),
  );
}
