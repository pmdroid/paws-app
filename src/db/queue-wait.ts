import { and, asc, eq, ne, sql } from "drizzle-orm";
import type { Db, Q, Steps } from "./db";
import type { QueueWaitingFor } from "./runner-verdicts";

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
  waitingFor: QueueWaitingFor | null;
};

/** Replace the waiting line. The scheduler writes it after every admission pass. */
export function saveQueuePositions(
  db: Db,
  waiting: readonly string[],
  slots: { busy: number; total: number } | null,
  now: number,
  ownerCaps: ReadonlyMap<string, number> = new Map(),
  waitingFor: ReadonlyMap<string, QueueWaitingFor> = new Map(),
): Promise<void> {
  return db.transaction((q) =>
    saveQueuePositionsSteps(q, waiting, slots, now, ownerCaps, waitingFor),
  );
}

export function* saveQueuePositionsSteps(
  q: Q,
  waiting: readonly string[],
  slots: { busy: number; total: number } | null,
  now: number,
  ownerCaps: ReadonlyMap<string, number> = new Map(),
  waitingFor: ReadonlyMap<string, QueueWaitingFor> = new Map(),
): Steps<void> {
  const rows =
    slots === null
      ? []
      : waiting.map((itemId, index) => ({
          itemId,
          position: index + 1,
          busySlots: slots.busy,
          totalSlots: slots.total,
          ownerCap: ownerCaps.get(itemId) ?? null,
          waitingFor: waitingFor.get(itemId) ?? null,
          updatedAt: now,
        }));
  yield* q.exec(
    q.orm
      .select({ lock: sql`pg_advisory_xact_lock(hashtextextended(${"queue-position"}, 0))` })
      .from(sql`(SELECT 1) AS lock_scope`),
  );
  yield* q.exec(q.orm.delete(q.t.queuePosition));
  if (rows.length > 0) yield* q.exec(q.orm.insert(q.t.queuePosition).values(rows));
}

function* listSteps(q: Q): Steps<QueuePosition[]> {
  const { queuePosition } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        itemId: queuePosition.itemId,
        position: queuePosition.position,
        busySlots: queuePosition.busySlots,
        totalSlots: queuePosition.totalSlots,
        ownerCap: queuePosition.ownerCap,
        waitingFor: queuePosition.waitingFor,
      })
      .from(queuePosition)
      .orderBy(asc(queuePosition.position)),
  );
  return rows.map((row) => ({ ...row, waitingFor: row.waitingFor as QueueWaitingFor | null }));
}

export function listQueuePositions(db: Db): Promise<QueuePosition[]> {
  return db.run(listSteps);
}

export function getQueuePosition(db: Db, itemId: string): Promise<QueuePosition | null> {
  return db.run((q) => queuePositionSteps(q, itemId));
}

export function* queuePositionSteps(q: Q, itemId: string): Steps<QueuePosition | null> {
  const entries = yield* listSteps(q);
  return entries.find((entry) => entry.itemId === itemId) ?? null;
}
