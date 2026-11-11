import { eq, sql } from "drizzle-orm";
import { type Q, type Db } from "./db";

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

export async function recordBlockerChecks(
  store: Db,
  itemIds: readonly string[],
  at: number,
): Promise<void> {
  await store.transaction((q) => recordBlockerChecksSteps(q, itemIds, at));
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

export async function blockerCheckedAt(store: Db, itemId: string): Promise<number | null> {
  return store.run((q) => blockerCheckedAtSteps(q, itemId));
}
