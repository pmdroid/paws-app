import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Db, Q } from "./db";

export function queueWaitSince(
  db: Db,
  itemId: string,
  version: number,
  now: number,
): Promise<number> {
  return db.run(function* (q) {
    const { itemWait } = q.t;
    yield* q.exec(
      q.orm
        .insert(itemWait)
        .values({ itemId, kind: "queue", version, since: now })
        .onConflictDoUpdate({
          target: [itemWait.itemId, itemWait.kind],
          set: { version, since: now },
          setWhere: ne(itemWait.version, sql`excluded.version`),
        }),
    );
    const row = yield* q.one(
      q.orm
        .select({ since: itemWait.since })
        .from(itemWait)
        .where(and(eq(itemWait.itemId, itemId), eq(itemWait.kind, "queue"))),
    );
    return row!.since;
  });
}

/** Forget when an item began waiting for a slot, so its start timeout counts from the next wait. */
export function clearQueueWait(db: Db, itemId: string): Promise<void> {
  return db.run(function* (q) {
    const { itemWait } = q.t;
    yield* q.exec(
      q.orm.delete(itemWait).where(and(eq(itemWait.itemId, itemId), eq(itemWait.kind, "queue"))),
    );
  });
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
  return db.transaction(function* (q) {
    yield* q.exec(q.orm.delete(q.t.queuePosition));
    if (rows.length > 0) yield* q.exec(q.orm.insert(q.t.queuePosition).values(rows));
  });
}

function* listSteps(q: Q) {
  const { queuePosition } = q.t;
  return yield* q.all(
    q.orm
      .select({
        itemId: queuePosition.itemId,
        position: queuePosition.position,
        busySlots: queuePosition.busySlots,
        totalSlots: queuePosition.totalSlots,
        ownerCap: queuePosition.ownerCap,
      })
      .from(queuePosition)
      .orderBy(asc(queuePosition.position)),
  );
}

export function listQueuePositions(db: Db): Promise<QueuePosition[]> {
  return db.run(listSteps);
}

export function getQueuePosition(db: Db, itemId: string): Promise<QueuePosition | null> {
  return db.run(function* (q) {
    const entries = yield* listSteps(q);
    return entries.find((entry) => entry.itemId === itemId) ?? null;
  });
}
