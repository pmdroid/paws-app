import { eq, sql } from "drizzle-orm";
import { type Q, type Db } from "./db";
import { cancelOpenJobsSteps } from "./jobs";
import { getWorkItemSteps, type WorkItemRecord } from "./items";
import { releaseMergeQueuePlaceSteps } from "./merge-queue";
import { runnerWorkSettledSteps } from "./runner-lease";
import { markRunSteps, releaseRunCapacitySteps } from "./runs";

export function* haltSteps(q: Q, item: WorkItemRecord, now: number) {
  const { schedulerAdmission, workItem } = q.t;
  const current = yield* getWorkItemSteps(q, item.id);
  if (!current || current.version !== item.version) return null;
  yield* q.exec(
    q.orm
      .update(workItem)
      .set({ version: sql`${workItem.version}+1` })
      .where(eq(workItem.id, item.id)),
  );
  yield* cancelOpenJobsSteps(q, { itemId: item.id, reason: "halt", now });
  if (current.currentRunId !== null) {
    if (yield* runnerWorkSettledSteps(q, current.currentRunId, now))
      yield* releaseRunCapacitySteps(q, current.currentRunId, now);
    else yield* markRunSteps(q, current.currentRunId, "ended", now);
  }
  yield* q.exec(q.orm.delete(schedulerAdmission).where(eq(schedulerAdmission.itemId, item.id)));
  yield* releaseMergeQueuePlaceSteps(q, item.id);
  return yield* getWorkItemSteps(q, item.id);
}

/** Fence old work and release all execution capacity. The caller applies its edge in this transaction. */
export async function halt(
  store: Db,
  item: WorkItemRecord,
  now: number,
): Promise<WorkItemRecord | null> {
  return store.transaction((q) => haltSteps(q, item, now));
}
