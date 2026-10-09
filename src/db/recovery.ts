import type { Database } from "bun:sqlite";
import { decideStartup, type StartupDecision, type WorkItemState } from "../core";
import { applyDecision } from "./decisions";
import { applyWorkItemEvent, listWorkItemsByStates } from "./items";
import { markRun } from "./runs";
import { immediate } from "./tx";

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
      });
      applyDecision(db, item, decision, now);
      decisions.push(decision);
    }
    return decisions;
  });
}

/**
 * SIGINT / SIGTERM. Running work moves to recovering without using the one
 * resume attempt. A merge in progress is left for a re-verify.
 */
export function prepareShutdown(db: Database, now = Date.now()): void {
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
