import type { Database } from "bun:sqlite";

export function queueWaitSince(db: Database, itemId: string, version: number, now: number): number {
  db.run("INSERT OR IGNORE INTO queue_wait(item_id,version,since) VALUES(?,?,?)", [
    itemId,
    version,
    now,
  ]);
  return db
    .query<{ since: number }, [string, number]>(
      "SELECT since FROM queue_wait WHERE item_id=? AND version=?",
    )
    .get(itemId, version)!.since;
}
