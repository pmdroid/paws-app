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
  /** 1 is next in line. */
  position: number;
  busySlots: number;
  totalSlots: number;
};

/** Replace the waiting line. The scheduler writes it after every admission pass. */
export function saveQueuePositions(
  db: Database,
  waiting: readonly string[],
  slots: { busy: number; total: number } | null,
  now: number,
): void {
  db.run("DELETE FROM queue_position");
  if (slots === null) return;
  waiting.forEach((itemId, index) =>
    db.run(
      "INSERT INTO queue_position(item_id,position,busy_slots,total_slots,updated_at) VALUES(?,?,?,?,?)",
      [itemId, index + 1, slots.busy, slots.total, now],
    ),
  );
}

export function listQueuePositions(db: Database): QueuePosition[] {
  return db
    .query<QueuePosition, []>(
      `SELECT item_id AS itemId,position,busy_slots AS busySlots,total_slots AS totalSlots
       FROM queue_position ORDER BY position`,
    )
    .all();
}

export function getQueuePosition(db: Database, itemId: string): QueuePosition | null {
  return listQueuePositions(db).find((entry) => entry.itemId === itemId) ?? null;
}
