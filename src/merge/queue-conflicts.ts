import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  enqueueJobOnce,
  getItemPullRequestSteps,
  getWorkItemSteps,
  immediate,
  itemJobRunning,
  itemJobRunningSteps,
  listMergeQueues,
  listMergeQueuesSteps,
  rebaseReturnedForSteps,
  recordRebaseReturn,
  type Db,
  type MergeQueuePosition,
  type WorkItemRecord,
} from "../db";
import type { RebaseConflict } from "./budget";
import {
  REBASE_CONFLICT_INSTRUCTION,
  REBASE_CONFLICT_THOUGHT,
  type OrderCapabilities,
} from "./orders";
import { askMergeHelp, rebaseBudgetFor, returnToAgent } from "./returns";

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
export function mainMoved(db: Database, input: QueueConflictSweep & { now: number }): void {
  if (behindFront(db, input.repository).length === 0) return;
  const payload: QueueConflictSweep = { repository: input.repository, main: input.main };
  enqueueJobOnce(db, {
    queue: JOB_KIND.queueConflicts,
    jobKey: `queue-conflicts:${input.repository.toLowerCase()}:${input.main ?? input.now}`,
    payload,
    now: input.now,
  });
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
  db: Database,
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
    const owned = () => behindFront(db, sweep.repository).includes(item.id);
    if (returnConflict(db, item, pull.pullNumber, read.head, conflict, caps, owned)) {
      handled.push(item.id);
      continue;
    }
    if (askSpentBudget(db, item, conflict, caps, owned)) handled.push(item.id);
  }
  if (handled.length > 0) await caps.voice.flush();
  return handled;
}

function returnConflict(
  db: Database,
  item: WorkItemRecord,
  pullNumber: number,
  head: string,
  conflict: RebaseConflict,
  caps: QueueConflictCapabilities,
  owned: () => boolean,
): boolean {
  return returnToAgent(db, {
    itemId: item.id,
    reason: "rebase-conflict",
    admit: () => owned() && rebaseBudgetFor(db, item.id, conflict, caps.now()).allowed,
    handoff: REBASE_CONFLICT_INSTRUCTION,
    now: caps.now(),
    keepPlace: true,
    conflict: { sessionId: caps.session(item), pullNumber, head },
    ...(caps.restart ? { restart: caps.restart } : {}),
    announce: (running, _, key) => caps.voice.thought(running, REBASE_CONFLICT_THOUGHT, key),
    record: (jobId) =>
      recordRebaseReturn(db, {
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
  db: Database,
  item: WorkItemRecord,
  conflict: RebaseConflict,
  caps: QueueConflictCapabilities,
  owned: () => boolean,
): boolean {
  return immediate(db, () => {
    if (!owned()) return false;
    const budget = rebaseBudgetFor(db, item.id, conflict, caps.now());
    return (
      !budget.allowed &&
      askMergeHelp(db, {
        itemId: item.id,
        body: `${budget.message} Reply with guidance to continue, or stop the task.`,
        reason: "rebase_budget_spent",
        now: caps.now(),
        session: caps.session,
        ask: caps.ask,
      })
    );
  });
}

/** Queued items in `repository` behind the front whose merge attempt is not running. */
function behindFront(db: Database, repository: string): string[] {
  return listMergeQueues(db)
    .filter((entry) => queuedBehind(entry, repository))
    .map((entry) => entry.itemId)
    .filter((itemId) => !mergeRunning(db, itemId));
}

/** {@link behindFront}, read through the store. */
function queuedBehindFront(store: Db, repository: string): Promise<string[]> {
  return store.run(function* (q) {
    const behind: string[] = [];
    for (const entry of yield* listMergeQueuesSteps(q))
      if (queuedBehind(entry, repository)) behind.push(entry.itemId);
    const waiting: string[] = [];
    for (const itemId of behind)
      if (!(yield* itemJobRunningSteps(q, JOB_KIND.merge, itemId))) waiting.push(itemId);
    return waiting;
  });
}

function queuedBehind(entry: MergeQueuePosition, repository: string): boolean {
  return entry.repository.toLowerCase() === repository.toLowerCase() && entry.position > 1;
}

function mergeRunning(db: Database, itemId: string): boolean {
  return itemJobRunning(db, JOB_KIND.merge, itemId);
}
