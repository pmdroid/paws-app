import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import { orm } from "./orm";
import { itemBlockerCheck } from "./schema";

export function recordBlockerChecks(db: Database, itemIds: readonly string[], at: number): void {
  db.transaction(() => {
    for (const itemId of itemIds)
      orm(db)
        .insert(itemBlockerCheck)
        .values({ itemId, checkedAt: at })
        .onConflictDoUpdate({
          target: itemBlockerCheck.itemId,
          set: { checkedAt: sql`MAX(${itemBlockerCheck.checkedAt},excluded.checked_at)` },
        })
        .run();
  }).immediate();
}

export function blockerCheckedAt(db: Database, itemId: string): number | null {
  return (
    orm(db)
      .select({ at: itemBlockerCheck.checkedAt })
      .from(itemBlockerCheck)
      .where(eq(itemBlockerCheck.itemId, itemId))
      .get()?.at ?? null
  );
}
