import type { Database } from "bun:sqlite";

export type ItemHoldReason =
  | "blocked"
  | "project"
  | "reconciling"
  | "snapshot"
  | "cap"
  | "slot"
  | "workspace"
  | "overlap";
/**
 * `blockers` names the blocking issues, or for `overlap` the item it waits for to merge. `files`
 * is set only for `overlap`: the conflict-prone files both items change.
 */
export type ItemHold = {
  itemId: string;
  reason: ItemHoldReason;
  blockers: string[];
  files?: string[];
};
export type ItemHoldChange = { itemId: string; held: ItemHold | null };

export function listItemHolds(db: Database): ItemHold[] {
  return db
    .query<{ itemId: string; reason: ItemHoldReason; blockers: string; files: string }, []>(
      "SELECT item_id AS itemId,reason,blockers,files FROM item_hold ORDER BY item_id",
    )
    .all()
    .map(({ files, ...row }) => {
      const paths = JSON.parse(files) as string[];
      return {
        ...row,
        blockers: JSON.parse(row.blockers) as string[],
        ...(paths.length ? { files: paths } : {}),
      };
    });
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
    const files = JSON.stringify(hold.files ?? []);
    const old = before.get(hold.itemId);
    if (
      old?.reason === hold.reason &&
      JSON.stringify(old.blockers) === blockers &&
      JSON.stringify(old.files ?? []) === files
    )
      continue;
    db.run(
      `INSERT INTO item_hold(item_id,reason,blockers,files) VALUES(?,?,?,?)
       ON CONFLICT(item_id) DO UPDATE SET reason=excluded.reason,blockers=excluded.blockers,
       files=excluded.files`,
      [hold.itemId, hold.reason, blockers, files],
    );
    changes.push({ itemId: hold.itemId, held: hold });
  }
  return changes;
}
