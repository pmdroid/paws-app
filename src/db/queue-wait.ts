import { and, asc, eq } from "drizzle-orm";
import type { Db } from "./db";
import type { Orm } from "./orm";
import { queuePosition, queueWait } from "./schema";
import * as pg from "./schema-pg";

export function queueWaitSince(
  db: Db,
  itemId: string,
  version: number,
  now: number,
): Promise<number> {
  if (db.dialect === "sqlite")
    return db.sync((handle) => {
      handle.insert(queueWait).values({ itemId, version, since: now }).onConflictDoNothing().run();
      return handle
        .select({ since: queueWait.since })
        .from(queueWait)
        .where(and(eq(queueWait.itemId, itemId), eq(queueWait.version, version)))
        .get()!.since;
    });
  const handle = db.orm;
  return (async () => {
    await handle.insert(pg.queueWait).values({ itemId, version, since: now }).onConflictDoNothing();
    const [row] = await handle
      .select({ since: pg.queueWait.since })
      .from(pg.queueWait)
      .where(and(eq(pg.queueWait.itemId, itemId), eq(pg.queueWait.version, version)));
    return row!.since;
  })();
}

/** Forget when an item began waiting for a slot, so its start timeout counts from the next wait. */
export function clearQueueWait(db: Db, itemId: string): Promise<void> {
  if (db.dialect === "sqlite")
    return db.sync((handle) => {
      handle.delete(queueWait).where(eq(queueWait.itemId, itemId)).run();
    });
  return db.orm
    .delete(pg.queueWait)
    .where(eq(pg.queueWait.itemId, itemId))
    .then(() => undefined);
}

/** A queued item's place among the items waiting for a runner slot. */
export type QueuePosition = {
  itemId: string;
  /** 1 is next in line. */
  position: number;
  busySlots: number;
  totalSlots: number;
  ownerCap: number | null;
};

/** Replace the waiting line. The scheduler writes it after every admission pass. */
export function saveQueuePositions(
  db: Db,
  waiting: readonly string[],
  slots: { busy: number; total: number } | null,
  now: number,
  ownerCaps: ReadonlyMap<string, number> = new Map(),
): Promise<void> {
  const rows =
    slots === null
      ? []
      : waiting.map((itemId, index) => ({
          itemId,
          position: index + 1,
          busySlots: slots.busy,
          totalSlots: slots.total,
          ownerCap: ownerCaps.get(itemId) ?? null,
          updatedAt: now,
        }));
  if (db.dialect === "sqlite")
    return db.sync((handle) => {
      handle.delete(queuePosition).run();
      for (const row of rows) handle.insert(queuePosition).values(row).run();
    });
  return db.orm.transaction(async (tx) => {
    await tx.delete(pg.queuePosition);
    if (rows.length > 0) await tx.insert(pg.queuePosition).values(rows);
  });
}

function listSqlite(handle: Orm): QueuePosition[] {
  return handle
    .select({
      itemId: queuePosition.itemId,
      position: queuePosition.position,
      busySlots: queuePosition.busySlots,
      totalSlots: queuePosition.totalSlots,
      ownerCap: queuePosition.ownerCap,
    })
    .from(queuePosition)
    .orderBy(asc(queuePosition.position))
    .all();
}

export function listQueuePositions(db: Db): Promise<QueuePosition[]> {
  if (db.dialect === "sqlite") return db.sync(listSqlite);
  return db.orm
    .select({
      itemId: pg.queuePosition.itemId,
      position: pg.queuePosition.position,
      busySlots: pg.queuePosition.busySlots,
      totalSlots: pg.queuePosition.totalSlots,
      ownerCap: pg.queuePosition.ownerCap,
    })
    .from(pg.queuePosition)
    .orderBy(asc(pg.queuePosition.position));
}

export function getQueuePosition(db: Db, itemId: string): Promise<QueuePosition | null> {
  const find = (entries: QueuePosition[]) =>
    entries.find((entry) => entry.itemId === itemId) ?? null;
  if (db.dialect === "sqlite") return db.sync((handle) => find(listSqlite(handle)));
  return listQueuePositions(db).then(find);
}
