import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { orm } from "./orm";
import { mergeCarriedAccept } from "./schema";

/**
 * Under `[merge] main_moved` `ci` or `overlap`, the merge lane rebased `acceptedHead`, which
 * Closeout accepted, onto main `base` and pushed `head`. Closeout's acceptance carries to `head`
 * only while the item's accepted head is still `acceptedHead`.
 */
export function recordCarriedAccept(
  db: Database,
  input: { itemId: string; head: string; acceptedHead: string; base: string; now: number },
): void {
  const values = { acceptedHead: input.acceptedHead, base: input.base, recordedAt: input.now };
  orm(db)
    .insert(mergeCarriedAccept)
    .values({ itemId: input.itemId, head: input.head, ...values })
    .onConflictDoUpdate({
      target: [mergeCarriedAccept.itemId, mergeCarriedAccept.head],
      set: values,
    })
    .run();
}

/** The accepted head the lane rebased into `head`, or null when `head` is not a carried rebase. */
export function carriedAcceptFor(db: Database, itemId: string, head: string): string | null {
  return (
    orm(db)
      .select({ acceptedHead: mergeCarriedAccept.acceptedHead })
      .from(mergeCarriedAccept)
      .where(and(eq(mergeCarriedAccept.itemId, itemId), eq(mergeCarriedAccept.head, head)))
      .get()?.acceptedHead ?? null
  );
}
