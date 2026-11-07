import type { Database } from "bun:sqlite";
import { and, asc, eq } from "drizzle-orm";
import { orm } from "./orm";
import { queuePosition, queueWait } from "./schema";

export function queueWaitSince(db: Database, itemId: string, version: number, now: number): number {
  const handle = orm(db);
  handle.insert(queueWait).values({ itemId, version, since: now }).onConflictDoNothing().run();
  return handle
    .select({ since: queueWait.since })
    .from(queueWait)
    .where(and(eq(queueWait.itemId, itemId), eq(queueWait.version, version)))
    .get()!.since;
}

/** Forget when an item began waiting for a slot, so its start timeout counts from the next wait. */
export function clearQueueWait(db: Database, itemId: string): void {
  orm(db).delete(queueWait).where(eq(queueWait.itemId, itemId)).run();
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
  db: Database,
  waiting: readonly string[],
  slots: { busy: number; total: number } | null,
  now: number,
  ownerCaps: ReadonlyMap<string, number> = new Map(),
): void {
  const handle = orm(db);
  handle.delete(queuePosition).run();
  if (slots === null) return;
  waiting.forEach((itemId, index) =>
    handle
      .insert(queuePosition)
      .values({
        itemId,
        position: index + 1,
        busySlots: slots.busy,
        totalSlots: slots.total,
        ownerCap: ownerCaps.get(itemId) ?? null,
        updatedAt: now,
      })
      .run(),
  );
}

export function listQueuePositions(db: Database): QueuePosition[] {
  return orm(db)
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

export function getQueuePosition(db: Database, itemId: string): QueuePosition | null {
  return listQueuePositions(db).find((entry) => entry.itemId === itemId) ?? null;
}
