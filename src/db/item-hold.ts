import type { Database } from "bun:sqlite";

export type ItemHoldReason =
  | "blocked"
  | "project"
  | "reconciling"
  | "snapshot"
  | "cap"
  | "slot"
  | "workspace";
export type ItemHold = { itemId: string; reason: ItemHoldReason; blockers: string[] };
export type ItemHoldChange = { itemId: string; held: ItemHold | null };

export function listItemHolds(db: Database): ItemHold[] {
  return db
    .query<{ itemId: string; reason: ItemHoldReason; blockers: string }, []>(
      "SELECT item_id AS itemId,reason,blockers FROM item_hold ORDER BY item_id",
    )
    .all()
    .map((row) => ({ ...row, blockers: JSON.parse(row.blockers) as string[] }));
}

export function saveItemHolds(db: Database, holds: readonly ItemHold[]): ItemHoldChange[] {
  const before = new Map(listItemHolds(db).map((hold) => [hold.itemId, hold]));
  const kept = new Set(holds.map((hold) => hold.itemId));
  const changes: ItemHoldChange[] = [];
  for (const itemId of before.keys())
    if (!kept.has(itemId)) {
      db.run("DELETE FROM item_hold WHERE item_id=?", [itemId]);
      changes.push({ itemId, held: null });
    }
  for (const hold of holds) {
    const blockers = JSON.stringify(hold.blockers);
    const old = before.get(hold.itemId);
    if (old?.reason === hold.reason && JSON.stringify(old.blockers) === blockers) continue;
    db.run(
      `INSERT INTO item_hold(item_id,reason,blockers) VALUES(?,?,?)
       ON CONFLICT(item_id) DO UPDATE SET reason=excluded.reason,blockers=excluded.blockers`,
      [hold.itemId, hold.reason, blockers],
    );
    changes.push({ itemId: hold.itemId, held: hold });
  }
  return changes;
}
