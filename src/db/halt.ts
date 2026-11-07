import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import { cancelOpenJobs } from "./jobs";
import { getWorkItem, type WorkItemRecord } from "./items";
import { releaseMergeQueuePlace } from "./merge-queue";
import { runnerWorkSettled } from "./runner-lease";
import { orm } from "./orm";
import { markRun, releaseRunCapacity } from "./runs";
import { schedulerAdmission, workItem } from "./schema";
import { immediate } from "./tx";

/** Fence old work and release all execution capacity. The caller applies its edge in this transaction. */
export function halt(db: Database, item: WorkItemRecord, now: number): WorkItemRecord | null {
  return immediate(db, () => {
    const current = getWorkItem(db, item.id);
    if (!current || current.version !== item.version) return null;
    orm(db)
      .update(workItem)
      .set({ version: sql`${workItem.version}+1` })
      .where(eq(workItem.id, item.id))
      .run();
    cancelOpenJobs(db, { itemId: item.id, reason: "halt", now });
    if (current.currentRunId !== null) {
      if (runnerWorkSettled(db, current.currentRunId, now))
        releaseRunCapacity(db, current.currentRunId, now);
      else markRun(db, current.currentRunId, "ended", now);
    }
    orm(db).delete(schedulerAdmission).where(eq(schedulerAdmission.itemId, item.id)).run();
    releaseMergeQueuePlace(db, item.id);
    return getWorkItem(db, item.id);
  });
}
