import type { Database } from "bun:sqlite";

/**
 * Under `[merge] main_moved` `ci` or `overlap`, the merge lane rebased `acceptedHead`, which
 * Closeout accepted, onto main `base` and pushed `head`. Closeout's acceptance carries to `head`
 * only while the item's accepted head is still `acceptedHead`.
 */
export function recordCarriedAccept(
  db: Database,
  input: { itemId: string; head: string; acceptedHead: string; base: string; now: number },
): void {
  db.run(
    `INSERT OR REPLACE INTO merge_carried_accept(item_id, head, accepted_head, base, recorded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [input.itemId, input.head, input.acceptedHead, input.base, input.now],
  );
}

/** The accepted head the lane rebased into `head`, or null when `head` is not a carried rebase. */
export function carriedAcceptFor(db: Database, itemId: string, head: string): string | null {
  return (
    db
      .query<{ acceptedHead: string }, [string, string]>(
        `SELECT accepted_head AS acceptedHead FROM merge_carried_accept WHERE item_id = ? AND head = ?`,
      )
      .get(itemId, head)?.acceptedHead ?? null
  );
}
