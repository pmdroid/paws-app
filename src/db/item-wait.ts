import type { Database } from "bun:sqlite";
import { eq, ne, notInArray, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

export function* itemWaitSinceSteps(q: Q, itemId: string, version: number, now: number) {
  const { itemWait } = q.t;
  yield* q.exec(
    q.orm
      .insert(itemWait)
      .values({ itemId, version, since: now })
      .onConflictDoUpdate({
        target: itemWait.itemId,
        set: { version, since: now },
        setWhere: ne(itemWait.version, sql`excluded.version`),
      }),
  );
  const row = yield* q.one(
    q.orm.select({ since: itemWait.since }).from(itemWait).where(eq(itemWait.itemId, itemId)),
  );
  return row!.since;
}

export function itemWaitSince(db: Database, itemId: string, version: number, now: number): number {
  return settled(sqliteDb(db).run((q) => itemWaitSinceSteps(q, itemId, version, now)));
}

export function* keepItemWaitsSteps(q: Q, itemIds: readonly string[]) {
  const { itemWait } = q.t;
  yield* q.exec(
    itemIds.length === 0
      ? q.orm.delete(itemWait)
      : q.orm.delete(itemWait).where(notInArray(itemWait.itemId, [...itemIds])),
  );
}

export function keepItemWaits(db: Database, itemIds: readonly string[]): void {
  settled(sqliteDb(db).run((q) => keepItemWaitsSteps(q, itemIds)));
}
