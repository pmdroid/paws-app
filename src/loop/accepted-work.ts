import type { Database } from "bun:sqlite";
import { JOB_KIND, type WorkItemEvent, type WorkItemState } from "../core";
import {
  applyWorkItemEvent,
  enqueueJobOnce,
  getRun,
  getWorkItem,
  immediate,
  leaveMergeQueue,
  markRun,
  saveCheckpoint,
} from "../db";

/**
 * The existing edges that carry an item from where it waits to `merge_queue`, the way an accepted
 * turn goes: the turn ends, then Closeout's acceptance applies. No new edge and no second machine.
 */
const TO_MERGE_QUEUE: Partial<Record<WorkItemState, readonly WorkItemEvent[]>> = {
  queued: ["dispatched", "turn_ended", "closeout_accepted"],
  running: ["turn_ended", "closeout_accepted"],
  paused: ["resume", "turn_ended", "closeout_accepted"],
  recovering: ["recovered", "turn_ended", "closeout_accepted"],
  awaiting_input: ["answer_received", "turn_ended", "closeout_accepted"],
  verifying: ["closeout_accepted"],
};

/**
 * Restart reasons that bring the agent something new: a person's reply, CI, review comments,
 * a conflict, Closeout findings or an outdated visual review. Any other resume of accepted work,
 * such as a recovery or a transient retry, would only redo it.
 */
const NEW_INPUT = new Set([
  "answer",
  "follow_up",
  "ci",
  "review",
  "conflict",
  "findings",
  "visual-review",
]);

/** Whether a resume of an accepted item still needs an agent turn instead of the merge queue. */
export function acceptedResumeNeedsTurn(input: {
  acceptedHead: string | null;
  pullHead: string | null;
  reason: string | null;
}): boolean {
  if (input.acceptedHead === null || input.pullHead !== input.acceptedHead) return true;
  return input.reason !== null && NEW_INPUT.has(input.reason);
}

/**
 * Sends an item whose work Closeout accepted to the merge queue at its accepted head instead of
 * another agent turn. Pending agent jobs, other than `exceptJobId`, are cancelled and the current
 * run ends. Returns false when the item has no accepted head or cannot get there from its state.
 */
export function mergeAcceptedWork(
  db: Database,
  itemId: string,
  input: { now: number; exceptJobId?: number },
): boolean {
  return immediate(db, () => {
    const item = getWorkItem(db, itemId);
    const path = item ? TO_MERGE_QUEUE[item.state] : undefined;
    if (!item || item.cancelRequested || item.acceptedHead === null || !path) return false;
    const head = item.acceptedHead;
    db.run(
      `UPDATE job
       SET status = 'cancelled', last_error = 'accepted_work', locked_by = NULL,
           locked_until = NULL, finished_at = ?
       WHERE status IN ('pending', 'running') AND queue IN (?, ?) AND id <> ?
         AND json_extract(payload, '$.itemId') = ?`,
      [input.now, JOB_KIND.start, JOB_KIND.resume, input.exceptJobId ?? -1, itemId],
    );
    if (item.currentRunId !== null) {
      const run = getRun(db, item.currentRunId);
      if (run?.status === "active" || run?.status === "provisioning")
        markRun(db, run.id, "ended", input.now);
    }
    for (const event of path) applyWorkItemEvent(db, itemId, event, { now: input.now });
    saveCheckpoint(db, itemId, { ...item.checkpoint, phase: "merge_queue", wipCommit: head });
    leaveMergeQueue(db, itemId);
    const queued = getWorkItem(db, itemId)!;
    const summary =
      db
        .query<{ summary: string | null }, [string, string]>(
          `SELECT json_extract(payload, '$.summary') AS summary FROM job
           WHERE queue = ? AND json_extract(payload, '$.itemId') = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(JOB_KIND.merge, itemId)?.summary ?? "Closeout accepted.";
    enqueueJobOnce(db, {
      queue: JOB_KIND.merge,
      jobKey: `merge:${itemId}:${head}:accepted:${queued.version}`,
      payload: { itemId, summary, head },
      now: input.now,
    });
    return true;
  });
}

/**
 * A run's candidate push was rejected. When the remote branch is the accepted head, or contains
 * it, the accepted work is already on GitHub: the item goes to the merge queue instead of asking.
 * Returns false otherwise, so the rejection goes on to the push question and conflict handling.
 */
export function settleRejectedPush(
  db: Database,
  itemId: string,
  input: { remoteHead: string | null; containsAccepted: boolean; now: number },
): boolean {
  const accepted = getWorkItem(db, itemId)?.acceptedHead ?? null;
  if (accepted === null || (input.remoteHead !== accepted && !input.containsAccepted)) return false;
  return mergeAcceptedWork(db, itemId, { now: input.now });
}
