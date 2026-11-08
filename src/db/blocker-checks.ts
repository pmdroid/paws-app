import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

export function* recordBlockerChecksSteps(q: Q, itemIds: readonly string[], at: number) {
  const { itemBlockerCheck } = q.t;
  const later = q.dialect === "sqlite" ? sql`MAX` : sql`GREATEST`;
  for (const itemId of itemIds)
    yield* q.exec(
      q.orm
        .insert(itemBlockerCheck)
        .values({ itemId, checkedAt: at })
        .onConflictDoUpdate({
          target: itemBlockerCheck.itemId,
          set: { checkedAt: sql`${later}(${itemBlockerCheck.checkedAt},excluded.checked_at)` },
        }),
    );
}

export function recordBlockerChecks(db: Database, itemIds: readonly string[], at: number): void {
  settled(sqliteDb(db).transaction((q) => recordBlockerChecksSteps(q, itemIds, at)));
}

export function* blockerCheckedAtSteps(q: Q, itemId: string) {
  const { itemBlockerCheck } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ at: itemBlockerCheck.checkedAt })
      .from(itemBlockerCheck)
      .where(eq(itemBlockerCheck.itemId, itemId)),
  );
  return row?.at ?? null;
}

export function blockerCheckedAt(db: Database, itemId: string): number | null {
  return settled(sqliteDb(db).run((q) => blockerCheckedAtSteps(q, itemId)));
}
