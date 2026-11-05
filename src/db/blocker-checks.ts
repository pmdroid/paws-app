import type { Database } from "bun:sqlite";

export function recordBlockerChecks(db: Database, itemIds: readonly string[], at: number): void {
  db.transaction(() => {
    for (const itemId of itemIds)
      db.run(
        `INSERT INTO item_blocker_check(item_id,checked_at) VALUES(?,?)
         ON CONFLICT(item_id) DO UPDATE SET checked_at=MAX(checked_at,excluded.checked_at)`,
        [itemId, at],
      );
  }).immediate();
}

export function blockerCheckedAt(db: Database, itemId: string): number | null {
  return (
    db
      .query<{ at: number }, [string]>(
        "SELECT checked_at AS at FROM item_blocker_check WHERE item_id=?",
      )
      .get(itemId)?.at ?? null
  );
}
