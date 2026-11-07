import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

type CarriedAccept = {
  itemId: string;
  head: string;
  acceptedHead: string;
  base: string;
  now: number;
};

export function* recordCarriedAcceptSteps(q: Q, input: CarriedAccept) {
  const { mergeCarriedAccept } = q.t;
  const values = { acceptedHead: input.acceptedHead, base: input.base, recordedAt: input.now };
  yield* q.exec(
    q.orm
      .insert(mergeCarriedAccept)
      .values({ itemId: input.itemId, head: input.head, ...values })
      .onConflictDoUpdate({
        target: [mergeCarriedAccept.itemId, mergeCarriedAccept.head],
        set: values,
      }),
  );
}

/**
 * Under `[merge] main_moved` `ci` or `overlap`, the merge lane rebased `acceptedHead`, which
 * Closeout accepted, onto main `base` and pushed `head`. Closeout's acceptance carries to `head`
 * only while the item's accepted head is still `acceptedHead`.
 */
export function recordCarriedAccept(db: Database, input: CarriedAccept): void {
  settled(sqliteDb(db).run((q) => recordCarriedAcceptSteps(q, input)));
}

export function* carriedAcceptForSteps(q: Q, itemId: string, head: string) {
  const { mergeCarriedAccept } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ acceptedHead: mergeCarriedAccept.acceptedHead })
      .from(mergeCarriedAccept)
      .where(and(eq(mergeCarriedAccept.itemId, itemId), eq(mergeCarriedAccept.head, head))),
  );
  return row?.acceptedHead ?? null;
}

/** The accepted head the lane rebased into `head`, or null when `head` is not a carried rebase. */
export function carriedAcceptFor(db: Database, itemId: string, head: string): string | null {
  return settled(sqliteDb(db).run((q) => carriedAcceptForSteps(q, itemId, head)));
}
