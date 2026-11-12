import { JOB_KIND } from "../core";
import {
  emitJobReady,
  enqueueJobOnceSteps,
  getItemPullRequestSteps,
  getWorkItemSteps,
  itemJobRunningSteps,
  listMergeQueuesSteps,
  rebaseReturnedForSteps,
  recordRebaseReturnSteps,
  type Db,
  type MergeQueuePosition,
  type Q,
  type Steps,
  type WorkItemRecord,
} from "../db";
import type { RebaseConflict } from "./budget";
import {
  REBASE_CONFLICT_INSTRUCTION,
  REBASE_CONFLICT_THOUGHT,
  type OrderCapabilities,
} from "./orders";
import { askMergeHelpSteps, rebaseBudgetForSteps, returnToAgent } from "./returns";

export type QueueConflictCapabilities = Pick<
  OrderCapabilities,
  "ask" | "now" | "session" | "restart" | "readPull"
> & {
  voice: Pick<OrderCapabilities["voice"], "thought" | "flush">;
};

/** The sweep's payload: the repository as the merge queue names it, and main's new commit. */
export type QueueConflictSweep = { repository: string; main: string | null };

/**
 * Main moved in `repository`: check the queued pull requests behind the front once for this main
 * commit. A redelivered webhook, or the lane's merge and its webhook, share the one job.
 */
export async function mainMoved(
  store: Db,
  input: QueueConflictSweep & { now: number },
): Promise<void> {
  if (await store.run((q) => mainMovedSteps(q, input))) emitJobReady(store);
}

export function* mainMovedSteps(q: Q, input: QueueConflictSweep & { now: number }): Steps<boolean> {
  if ((yield* behindFrontSteps(q, input.repository)).length === 0) return false;
  return (yield* enqueueJobOnceSteps(q, sweepJob(input))).inserted;
}

function sweepJob(input: QueueConflictSweep & { now: number }) {
  const payload: QueueConflictSweep = { repository: input.repository, main: input.main };
  return {
    queue: JOB_KIND.queueConflicts,
    jobKey: `queue-conflicts:${input.repository.toLowerCase()}:${input.main ?? input.now}`,
    payload,
    now: input.now,
  };
}

export function queueConflictSweep(payload: unknown): QueueConflictSweep | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { repository, main } = payload as Record<string, unknown>;
  if (typeof repository !== "string") return null;
  return { repository, main: typeof main === "string" ? main : null };
}

/**
 * Send every queued pull request behind the front that now conflicts with main back for its
 * rebase, through the lane's conflict return and rebase budget, keeping its place in the queue.
 * The front is the lane's own; a pull request only behind main waits for the lane to update it.
 * Each head goes back once. The ids sent back or asked about.
 */
export async function returnQueuedConflicts(
  store: Db,
  sweep: QueueConflictSweep,
  caps: QueueConflictCapabilities,
): Promise<string[]> {
  const handled: string[] = [];
  for (const itemId of await queuedBehindFront(store, sweep.repository)) {
    const item = await store.run((q) => getWorkItemSteps(q, itemId));
    if (!item || item.state !== "merge_queue" || item.cancelRequested) continue;
    const pull = await store.run((q) => getItemPullRequestSteps(q, item.id));
    if (pull === null) continue;
    const read = await caps.readPull(item, pull.pullNumber);
    if (read === null || !read.open || read.merges !== "conflict") continue;
    if (await store.run((q) => rebaseReturnedForSteps(q, item.id, read.head))) continue;
    const conflict: RebaseConflict = { base: sweep.main, files: null };
    // The read awaited GitHub: the item may have reached the front, or its merge may have started.
    // Judge that again in the transaction that sends it back or asks.
    const owned = function* (q: Q): Steps<boolean> {
      return (yield* behindFrontSteps(q, sweep.repository)).includes(item.id);
    };
    if (await returnConflict(store, item, pull.pullNumber, read.head, conflict, caps, owned)) {
      handled.push(item.id);
      continue;
    }
    if (await askSpentBudget(store, item, conflict, caps, owned)) handled.push(item.id);
  }
  if (handled.length > 0) await caps.voice.flush();
  return handled;
}

function returnConflict(
  store: Db,
  item: WorkItemRecord,
  pullNumber: number,
  head: string,
  conflict: RebaseConflict,
  caps: QueueConflictCapabilities,
  owned: (q: Q) => Steps<boolean>,
): Promise<boolean> {
  return returnToAgent(store, {
    itemId: item.id,
    reason: "rebase-conflict",
    admit: function* (q) {
      return (
        (yield* owned(q)) && (yield* rebaseBudgetForSteps(q, item.id, conflict, caps.now())).allowed
      );
    },
    handoff: REBASE_CONFLICT_INSTRUCTION,
    now: caps.now(),
    keepPlace: true,
    conflict: { sessionId: caps.session(item), pullNumber, head, base: conflict.base },
    ...(caps.restart ? { restart: caps.restart } : {}),
    announce: (q, running, _, key) => caps.voice.thought(q, running, REBASE_CONFLICT_THOUGHT, key),
    record: (q, jobId) =>
      recordRebaseReturnSteps(q, {
        itemId: item.id,
        jobId,
        candidate: head,
        reason: "merge",
        ...conflict,
        recordedAt: caps.now(),
      }),
  });
}

function askSpentBudget(
  store: Db,
  item: WorkItemRecord,
  conflict: RebaseConflict,
  caps: QueueConflictCapabilities,
  owned: (q: Q) => Steps<boolean>,
): Promise<boolean> {
  return store.transaction(function* (q): Steps<boolean> {
    if (!(yield* owned(q))) return false;
    const budget = yield* rebaseBudgetForSteps(q, item.id, conflict, caps.now());
    return (
      !budget.allowed &&
      (yield* askMergeHelpSteps(q, {
        itemId: item.id,
        body: `${budget.message} Reply with guidance to continue, or stop the task.`,
        reason: "rebase_budget_spent",
        now: caps.now(),
        session: caps.session,
        ask: caps.ask,
      }))
    );
  });
}

/** {@link behindFront}, read through the store. */
function queuedBehindFront(store: Db, repository: string): Promise<string[]> {
  return store.run((q) => behindFrontSteps(q, repository));
}

function* behindFrontSteps(q: Q, repository: string): Steps<string[]> {
  const behind: string[] = [];
  for (const entry of yield* listMergeQueuesSteps(q))
    if (queuedBehind(entry, repository)) behind.push(entry.itemId);
  const waiting: string[] = [];
  for (const itemId of behind)
    if (!(yield* itemJobRunningSteps(q, JOB_KIND.merge, itemId))) waiting.push(itemId);
  return waiting;
}

function queuedBehind(entry: MergeQueuePosition, repository: string): boolean {
  return entry.repository.toLowerCase() === repository.toLowerCase() && entry.position > 1;
}
