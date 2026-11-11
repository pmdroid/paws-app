import type { Database } from "bun:sqlite";
import { JOB_KIND, type WorkItemState } from "../core";
import {
  applyWorkItemEventSteps,
  cancelAcceptedWorkJobsSteps,
  closeoutPolicyDigestsSteps,
  emitJobReady,
  enqueueJobOnceSteps,
  getRunSteps,
  getWorkItemSteps,
  latestMergeJobSummarySteps,
  leaveMergeQueueSteps,
  markRunSteps,
  pendingRestartHandoffSteps,
  saveCheckpointSteps,
  settled,
  sqliteDb,
  type Q,
  type Steps,
} from "../db";

const ACCEPTS_FROM: ReadonlySet<WorkItemState> = new Set([
  "queued",
  "running",
  "paused",
  "recovering",
  "awaiting_input",
  "verifying",
]);

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
  handoff?: string | null;
}): boolean {
  if (input.acceptedHead === null || input.pullHead !== input.acceptedHead) return true;
  return Boolean(input.handoff?.trim()) || (input.reason !== null && NEW_INPUT.has(input.reason));
}

/**
 * Sends an item whose work Closeout accepted to the merge queue at its accepted head instead of
 * another agent turn. Pending agent jobs, other than `exceptJobId`, are cancelled and the current
 * run ends. Returns false when the item has no accepted head, cannot get there from its state, or
 * a later Closeout run on that head did not accept it. Automatic callers check for pending agent
 * input first; a person's Merge answer does not wait for it.
 */
type MergeInput = { now: number; exceptJobId?: number };

export function* mergeAcceptedWorkSteps(q: Q, itemId: string, input: MergeInput): Steps<boolean> {
  const item = yield* getWorkItemSteps(q, itemId);
  if (!item || item.cancelRequested || item.acceptedHead === null) return false;
  if (!ACCEPTS_FROM.has(item.state)) return false;
  const head = item.acceptedHead;
  const verdict = yield* closeoutPolicyDigestsSteps(q, itemId, head);
  if (verdict !== null && verdict.decision !== "accepted") return false;
  yield* cancelAcceptedWorkJobsSteps(q, itemId, input.now, input.exceptJobId);
  if (item.currentRunId !== null) {
    const run = yield* getRunSteps(q, item.currentRunId);
    if (run?.status === "active" || run?.status === "provisioning")
      yield* markRunSteps(q, run.id, "ended", input.now);
  }
  yield* applyWorkItemEventSteps(q, itemId, "closeout_accepted", { now: input.now });
  yield* saveCheckpointSteps(q, itemId, {
    ...item.checkpoint,
    phase: "merge_queue",
    wipCommit: head,
  });
  yield* leaveMergeQueueSteps(q, itemId);
  const queued = (yield* getWorkItemSteps(q, itemId))!;
  const summary = (yield* latestMergeJobSummarySteps(q, itemId)) ?? "Closeout accepted.";
  yield* enqueueJobOnceSteps(q, {
    queue: JOB_KIND.merge,
    jobKey: `merge:${itemId}:${head}:accepted:${queued.version}`,
    payload: { itemId, summary, head },
    now: input.now,
  });
  return true;
}

export function mergeAcceptedWork(db: Database, itemId: string, input: MergeInput): boolean {
  const merged = settled(sqliteDb(db).transaction((q) => mergeAcceptedWorkSteps(q, itemId, input)));
  if (merged) emitJobReady(db);
  return merged;
}

/**
 * A run's candidate push was rejected. When the remote branch is the accepted head, or contains
 * it, the accepted work is already on GitHub: the item goes to the merge queue instead of asking,
 * unless the run was delivering findings, review or CI input. Returns false otherwise, so the rejection goes on to the push question and conflict handling.
 */
export async function settleRejectedPush(
  db: Database,
  itemId: string,
  input: { remoteHead: string | null; containsAccepted: boolean; now: number },
): Promise<boolean> {
  const store = sqliteDb(db);
  const accepted = (await store.run((q) => getWorkItemSteps(q, itemId)))?.acceptedHead ?? null;
  if (accepted === null || (input.remoteHead !== accepted && !input.containsAccepted)) return false;
  // A turn carrying findings, review or CI input was not for nothing: it goes to the question.
  if ((await store.run((q) => pendingRestartHandoffSteps(q, itemId))).handoff) return false;
  return mergeAcceptedWork(db, itemId, { now: input.now });
}
