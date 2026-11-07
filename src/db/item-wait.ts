import type { Database } from "bun:sqlite";
import { eq, ne, sql } from "drizzle-orm";
import { orm } from "./orm";
import { itemWait } from "./schema";

export function itemWaitSince(db: Database, itemId: string, version: number, now: number): number {
  orm(db)
    .insert(itemWait)
    .values({ itemId, version, since: now })
    .onConflictDoUpdate({
      target: itemWait.itemId,
      set: { version, since: now },
      setWhere: ne(itemWait.version, sql`excluded.version`),
    })
    .run();
  return orm(db)
    .select({ since: itemWait.since })
    .from(itemWait)
    .where(eq(itemWait.itemId, itemId))
    .get()!.since;
}

export function keepItemWaits(db: Database, itemIds: readonly string[]): void {
  orm(db)
    .delete(itemWait)
    .where(sql`${itemWait.itemId} NOT IN (SELECT value FROM json_each(${JSON.stringify(itemIds)}))`)
    .run();
}
