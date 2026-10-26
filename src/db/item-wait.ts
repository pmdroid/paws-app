import type { Database } from "bun:sqlite";

/**
 * When a queued item began its current wait at this version. A new version starts a new wait,
 * so a restart counts its "still waiting" marks from zero.
 */
export function itemWaitSince(db: Database, itemId: string, version: number, now: number): number {
  db.run(
    `INSERT INTO item_wait(item_id,version,since) VALUES(?,?,?)
     ON CONFLICT(item_id) DO UPDATE SET version=excluded.version,since=excluded.since
     WHERE item_wait.version<>excluded.version`,
    [itemId, version, now],
  );
  return db
    .query<{ since: number }, [string]>("SELECT since FROM item_wait WHERE item_id=?")
    .get(itemId)!.since;
}

/** Forget every wait except these items'. The scheduler calls it after each admission pass. */
export function keepItemWaits(db: Database, itemIds: readonly string[]): void {
  db.run("DELETE FROM item_wait WHERE item_id NOT IN (SELECT value FROM json_each(?))", [
    JSON.stringify(itemIds),
  ]);
}
