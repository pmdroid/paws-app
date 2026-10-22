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

/** A queued item's place among the items waiting for a runner slot. */
export type QueuePosition = {
  itemId: string;
  position: number;
  busySlots: number;
  totalSlots: number;
  updatedAt: number;
};

/** Replace the whole line. `itemIds` is in start order; an empty list clears it. */
export function replaceQueueLine(
  db: Database,
  input: { itemIds: readonly string[]; busySlots: number; totalSlots: number; now: number },
): void {
  db.run("DELETE FROM queue_position");
  input.itemIds.forEach((itemId, index) =>
    db.run(
      "INSERT INTO queue_position(item_id,position,busy_slots,total_slots,updated_at) VALUES(?,?,?,?,?)",
      [itemId, index + 1, input.busySlots, input.totalSlots, input.now],
    ),
  );
}

const POSITION_COLUMNS =
  "item_id AS itemId,position,busy_slots AS busySlots,total_slots AS totalSlots,updated_at AS updatedAt";

export function getQueuePosition(db: Database, itemId: string): QueuePosition | null {
  return db
    .query<QueuePosition, [string]>(
      `SELECT ${POSITION_COLUMNS} FROM queue_position WHERE item_id=?`,
    )
    .get(itemId);
}

export function listQueuePositions(db: Database): QueuePosition[] {
  return db
    .query<QueuePosition, []>(`SELECT ${POSITION_COLUMNS} FROM queue_position ORDER BY position`)
    .all();
}
