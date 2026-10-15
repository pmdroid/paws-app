import type { Database } from "bun:sqlite";
import { decideStartup, type StartupDecision, type WorkItemState } from "../core";
import { applyDecision } from "./decisions";
import { applyWorkItemEvent, listInFlightItems, listWorkItemsByStates } from "./items";
import type { WorkItemRecord } from "./items";
import { markRun } from "./runs";
import { immediate } from "./tx";
import { getTaskMode } from "./tasks";

/** Commit dirty files on the item branch. Sync, so shutdown can finish before exit. */
export type ShutdownWipCommit = (item: WorkItemRecord) => void;

const STARTUP_STATES = [
  "running",
  "verifying",
  "recovering",
  "merge_queue",
] as const satisfies readonly WorkItemState[];

/** On process start, resume a live run once or fail it. Merges fail closed. */
export function recoverOnStartup(db: Database, now = Date.now()): StartupDecision[] {
  return immediate(db, () => {
    const items = listWorkItemsByStates(db, STARTUP_STATES);
    const decisions: StartupDecision[] = [];
    for (const item of items) {
      const decision = decideStartup({
        itemState: item.state,
        recoveryAttempts: item.recoveryAttempts,
        checkpoint: item.checkpoint,
        taskMode: getTaskMode(db, item.id),
      });
      applyDecision(db, item, decision, now);
      decisions.push(decision);
    }
    return decisions;
  });
}

/**
 * SIGINT / SIGTERM. Commit WIP on each in-flight item branch, then move running
 * work to recovering without using the one resume attempt. A merge in progress
 * is left for a re-verify.
 */
export function prepareShutdown(
  db: Database,
  now = Date.now(),
  commitWip?: ShutdownWipCommit,
): void {
  if (commitWip !== undefined) {
    for (const item of listInFlightItems(db)) {
      try {
        commitWip(item);
      } catch {
        // The lease move still happens. A missing worktree is not a reason to skip shutdown.
      }
    }
  }
  immediate(db, () => {
    const running = listWorkItemsByStates(db, ["running", "verifying"]);
    for (const item of running) {
      if (item.currentRunId !== null) markRun(db, item.currentRunId, "lost", now);
      applyWorkItemEvent(db, item.id, "lease_expired");
    }
    const merging = listWorkItemsByStates(db, ["merge_queue"]);
    for (const item of merging) {
      if (item.currentRunId !== null) markRun(db, item.currentRunId, "lost", now);
      applyWorkItemEvent(db, item.id, "lease_expired");
    }
  });
}
