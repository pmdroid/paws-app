import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { JOB_KIND, type SystemFault } from "../core";
import {
  enqueueJob,
  enqueueJobOnce,
  getWorkItem,
  immediate,
  saveSystemFault,
  systemFaultAlertEpoch,
} from "../db";
import { publicToolText } from "./activity";

export function holdSystemFault(
  db: Database,
  itemId: string,
  fault: SystemFault,
  now: number,
): boolean {
  return immediate(db, () => {
    const item = getWorkItem(db, itemId);
    if (
      !item ||
      item.cancelRequested ||
      !["running", "verifying", "merge_queue", "recovering", "paused"].includes(item.state)
    )
      return false;
    const epoch = systemFaultAlertEpoch(db, fault.faultClass, randomUUID());
    const hold = saveSystemFault(db, {
      itemId,
      version: item.version,
      faultClass: fault.faultClass,
      reason: publicToolText(fault.message),
      now,
    });
    enqueueJob(db, {
      queue: ["verifying", "merge_queue"].includes(item.state)
        ? JOB_KIND.reverify
        : JOB_KIND.resume,
      payload: { itemId, systemFault: fault.faultClass },
      runAt: hold.retryAt,
      now,
    });
    enqueueJobOnce(db, {
      queue: "system.fault-alert",
      jobKey: `system-fault:${fault.faultClass}:${epoch}`,
      payload: { faultClass: fault.faultClass, epoch, alertId: randomUUID() },
      runAt: now + 5_000,
      now,
    });
    return true;
  });
}
