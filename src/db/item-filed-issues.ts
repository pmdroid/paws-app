import { asc, eq } from "drizzle-orm";
import type { Q, Steps } from "./db";
import type { itemFiledIssue } from "./schema-pg";

export type ItemFiledIssue = typeof itemFiledIssue.$inferSelect;

export function* recordItemFiledIssueSteps(q: Q, row: ItemFiledIssue): Steps<void> {
  yield* q.exec(q.orm.insert(q.t.itemFiledIssue).values(row).onConflictDoNothing());
}

export function* itemFiledIssuesSteps(q: Q, itemId: string): Steps<ItemFiledIssue[]> {
  const table = q.t.itemFiledIssue;
  return yield* q.all(
    q.orm
      .select()
      .from(table)
      .where(eq(table.itemId, itemId))
      .orderBy(asc(table.filedAt), asc(table.identifier)),
  );
}

export function* filedIssueOriginsSteps(q: Q, linearIssueId: string): Steps<ItemFiledIssue[]> {
  const table = q.t.itemFiledIssue;
  return yield* q.all(
    q.orm
      .select()
      .from(table)
      .where(eq(table.linearIssueId, linearIssueId))
      .orderBy(asc(table.filedAt), asc(table.itemId)),
  );
}
