import type { Database } from "bun:sqlite";
import { cancelOpenJobs } from "./jobs";
import { getWorkItem, type WorkItemRecord } from "./items";
import { leaveMergeQueue } from "./merge-queue";
import { runnerWorkSettled } from "./runner-lease";
import { markRun, releaseRunCapacity } from "./runs";
import { immediate } from "./tx";

/** Fence old work and release all execution capacity. The caller applies its edge in this transaction. */
export function halt(db: Database, item: WorkItemRecord, now: number): WorkItemRecord | null {
  return immediate(db, () => {
    const current = getWorkItem(db, item.id);
    if (!current || current.version !== item.version) return null;
    db.run("UPDATE work_item SET version=version+1 WHERE id=?", [item.id]);
    cancelOpenJobs(db, { itemId: item.id, reason: "halt", now });
    if (current.currentRunId !== null) {
      if (runnerWorkSettled(db, current.currentRunId, now))
        releaseRunCapacity(db, current.currentRunId, now);
      else markRun(db, current.currentRunId, "ended", now);
    }
    db.run("DELETE FROM scheduler_admission WHERE item_id=?", [item.id]);
    leaveMergeQueue(db, item.id);
    return getWorkItem(db, item.id);
  });
}
