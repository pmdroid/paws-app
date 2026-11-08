import type { Database } from "bun:sqlite";
import { asc, eq, isNotNull } from "drizzle-orm";
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
  start?: true;
};

const FINISHED = new Set(["completed", "merged", "cancelled"]);
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
      .where(isNotNull(itemHold.reason))
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

export function* listOverlapHoldAgesSteps(q: Q) {
  const { itemHold } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ itemId: itemHold.itemId, since: itemHold.overlapSince })
      .from(itemHold)
      .where(isNotNull(itemHold.overlapSince)),
  );
  return new Map(rows.map((row) => [row.itemId, row.since!]));
}

export function listOverlapHoldAges(db: Database): Map<string, number> {
  return settled(sqliteDb(db).run((q) => listOverlapHoldAgesSteps(q)));
}

export function* saveItemHoldsSteps(q: Q, holds: readonly ItemHold[], now = Date.now()) {
  const { itemHold, workItem } = q.t;
  const before = new Map((yield* listItemHoldsSteps(q)).map((hold) => [hold.itemId, hold]));
  const ages = yield* listOverlapHoldAgesSteps(q);
  const kept = new Set(holds.map((hold) => hold.itemId));
  const changes: ItemHoldChange[] = [];
  const finished = new Set(
    ages.size
      ? (yield* q.all(
          q.orm
            .select({ id: workItem.id, state: workItem.state })
            .from(itemHold)
            .innerJoin(workItem, eq(workItem.id, itemHold.itemId)),
        ))
          .filter((row) => FINISHED.has(row.state))
          .map((row) => row.id)
      : [],
  );
  for (const itemId of new Set([...before.keys(), ...ages.keys()])) {
    if (kept.has(itemId)) continue;
    if (ages.has(itemId) && !finished.has(itemId)) {
      if (!before.has(itemId)) continue;
      yield* q.exec(
        q.orm
          .update(itemHold)
          .set({ reason: null, blockers: jsonValue(q, []), files: jsonValue(q, []) })
          .where(eq(itemHold.itemId, itemId)),
      );
    } else yield* q.exec(q.orm.delete(itemHold).where(eq(itemHold.itemId, itemId)));
    if (before.has(itemId)) changes.push({ itemId, held: null });
  }
  for (const hold of holds) {
    const files = hold.files ?? [];
    const old = before.get(hold.itemId);
    const since = hold.reason === "overlap" ? (ages.get(hold.itemId) ?? now) : null;
    const same =
      old?.reason === hold.reason &&
      JSON.stringify(old.blockers) === JSON.stringify(hold.blockers) &&
      JSON.stringify(old.files ?? []) === JSON.stringify(files);
    if (same && (since === null || ages.has(hold.itemId))) continue;
    const values = {
      reason: hold.reason,
      blockers: jsonValue(q, hold.blockers),
      files: jsonValue(q, files),
      ...(since === null ? {} : { overlapSince: since }),
    };
    yield* q.exec(
      q.orm
        .insert(itemHold)
        .values({ itemId: hold.itemId, ...values })
        .onConflictDoUpdate({ target: itemHold.itemId, set: values }),
    );
    if (!same) changes.push({ itemId: hold.itemId, held: hold });
  }
  return changes;
}

export function saveItemHolds(
  db: Database,
  holds: readonly ItemHold[],
  now?: number,
): ItemHoldChange[] {
  return settled(sqliteDb(db).run((q) => saveItemHoldsSteps(q, holds, now)));
}
