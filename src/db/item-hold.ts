import type { Database } from "bun:sqlite";
import { asc, eq } from "drizzle-orm";
import { orm } from "./orm";
import { itemHold } from "./schema";

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
  return orm(db)
    .select()
    .from(itemHold)
    .orderBy(asc(itemHold.itemId))
    .all()
    .map(({ files, ...row }) => {
      const paths = JSON.parse(files) as string[];
      return {
        itemId: row.itemId,
        reason: row.reason as ItemHoldReason,
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
      orm(db).delete(itemHold).where(eq(itemHold.itemId, itemId)).run();
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
    orm(db)
      .insert(itemHold)
      .values({ itemId: hold.itemId, reason: hold.reason, blockers, files })
      .onConflictDoUpdate({
        target: itemHold.itemId,
        set: { reason: hold.reason, blockers, files },
      })
      .run();
    changes.push({ itemId: hold.itemId, held: hold });
  }
  return changes;
}
