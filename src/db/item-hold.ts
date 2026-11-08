import type { Database } from "bun:sqlite";
import { asc, eq } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import { jsonText, jsonValue } from "./json-text";

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

export function* listItemHoldsSteps(q: Q) {
  const { itemHold } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        itemId: itemHold.itemId,
        reason: itemHold.reason,
        blockers: jsonText(q, itemHold.blockers),
        files: jsonText(q, itemHold.files),
      })
      .from(itemHold)
      .orderBy(asc(itemHold.itemId)),
  );
  return rows.map(({ files, ...row }): ItemHold => {
    const paths = JSON.parse(files) as string[];
    return {
      itemId: row.itemId,
      reason: row.reason as ItemHoldReason,
      blockers: JSON.parse(row.blockers) as string[],
      ...(paths.length ? { files: paths } : {}),
    };
  });
}

export function listItemHolds(db: Database): ItemHold[] {
  return settled(sqliteDb(db).run((q) => listItemHoldsSteps(q)));
}

export function* saveItemHoldsSteps(q: Q, holds: readonly ItemHold[]) {
  const { itemHold } = q.t;
  const before = new Map((yield* listItemHoldsSteps(q)).map((hold) => [hold.itemId, hold]));
  const kept = new Set(holds.map((hold) => hold.itemId));
  const changes: ItemHoldChange[] = [];
  for (const itemId of before.keys())
    if (!kept.has(itemId)) {
      yield* q.exec(q.orm.delete(itemHold).where(eq(itemHold.itemId, itemId)));
      changes.push({ itemId, held: null });
    }
  for (const hold of holds) {
    const files = hold.files ?? [];
    const old = before.get(hold.itemId);
    if (
      old?.reason === hold.reason &&
      JSON.stringify(old.blockers) === JSON.stringify(hold.blockers) &&
      JSON.stringify(old.files ?? []) === JSON.stringify(files)
    )
      continue;
    const values = {
      reason: hold.reason,
      blockers: jsonValue(q, hold.blockers),
      files: jsonValue(q, files),
    };
    yield* q.exec(
      q.orm
        .insert(itemHold)
        .values({ itemId: hold.itemId, ...values })
        .onConflictDoUpdate({ target: itemHold.itemId, set: values }),
    );
    changes.push({ itemId: hold.itemId, held: hold });
  }
  return changes;
}

export function saveItemHolds(db: Database, holds: readonly ItemHold[]): ItemHoldChange[] {
  return settled(sqliteDb(db).run((q) => saveItemHoldsSteps(q, holds)));
}
