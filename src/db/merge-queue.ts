import { aliasedTable, and, asc, desc, eq, inArray, lt, max, ne, sql } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { type Q, type Steps, type Db } from "./db";
import { jsonField } from "./json-text";

/**
 * A task's place in its lane of its repository's merge queue. A lane is a Linear project, or `''`
 * for the repository-wide lane; lanes move independently. The first task in `merge_queue` moves; the
 * others wait. A task `verifying` while Closeout runs again is busy: it keeps its place but blocks
 * nobody, and moves before the tasks behind it once it is back in `merge_queue`. A task that went
 * back to the agent, waits for an answer, or ended holds no place.
 */
export type MergeQueuePosition = {
  itemId: string;
  repository: string;
  /** The lane's Linear project id, or `''` for the repository-wide lane. */
  lane: string;
  /** The lane's Linear project name, or null for the repository-wide lane or an unknown name. */
  laneName: string | null;
  /** 1 is the front of the lane. */
  position: number;
  total: number;
  readyAt: number;
  /** The task in front of this one, or null for the first. */
  aheadItemId: string | null;
  /** Re-verifying: keeps its place, but does not hold the lane. */
  busy: boolean;
  /**
   * The nearest ready task in front of this one, which merges before it. Null when none is: then
   * this task, if it is ready, is the one that moves.
   */
  nextItemId: string | null;
  /** The position Linear was last told about, or null. */
  notifiedPosition: number | null;
};

const HOLDING = ["merge_queue", "verifying"];

type JoinMergeQueue = { itemId: string; repository: string; lane?: string; now: number };

export function* joinMergeQueueSteps(q: Q, input: JoinMergeQueue) {
  yield* q.exec(
    q.orm
      .insert(q.t.mergeQueueEntry)
      .values({
        itemId: input.itemId,
        repository: input.repository.toLowerCase(),
        lane: input.lane ?? "",
        readyAt: input.now,
      })
      .onConflictDoNothing(),
  );
}

/**
 * Join the lane at the end, in the order tasks became ready. A task already in the queue keeps its
 * place and its lane. `lane` is a Linear project id, or `''` (the default) for the whole repository.
 */
export async function joinMergeQueue(store: Db, input: JoinMergeQueue): Promise<void> {
  await store.run((q) => joinMergeQueueSteps(q, input));
}

export function* leaveMergeQueueSteps(q: Q, itemId: string) {
  yield* q.exec(q.orm.delete(q.t.mergeQueueEntry).where(eq(q.t.mergeQueueEntry.itemId, itemId)));
}

export async function leaveMergeQueue(store: Db, itemId: string): Promise<void> {
  await store.run((q) => leaveMergeQueueSteps(q, itemId));
}

export function* inMergeQueueSteps(q: Q, itemId: string) {
  const { mergeQueueEntry, workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(mergeQueueEntry)
      .innerJoin(workItem, eq(workItem.id, mergeQueueEntry.itemId))
      .where(
        and(
          eq(mergeQueueEntry.itemId, itemId),
          inArray(workItem.state, HOLDING),
          eq(workItem.cancelRequested, 0),
        ),
      ),
  );
  return row !== undefined;
}

/** Whether the task holds a place in a merge queue: `merge_queue`, or `verifying` in it. */
export async function inMergeQueue(store: Db, itemId: string): Promise<boolean> {
  return store.run((q) => inMergeQueueSteps(q, itemId));
}

export function* restartedFromMergeQueueSteps(q: Q, itemId: string) {
  const { workItemEvent } = q.t;
  const restart = aliasedTable(workItemEvent, "r");
  const prior = aliasedTable(workItemEvent, "p");
  const latestRestart = q.orm
    .select({ id: max(restart.id) })
    .from(restart)
    .where(and(eq(restart.itemId, itemId), eq(restart.kind, "restart")));
  const enteredVerifyingFrom = q.orm
    .select({ fromState: prior.fromState })
    .from(prior)
    .where(
      and(
        eq(prior.itemId, itemId),
        lt(prior.id, workItemEvent.id),
        eq(prior.toState, "verifying"),
        ne(prior.fromState, "verifying"),
      ),
    )
    .orderBy(desc(prior.id))
    .limit(1);
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(workItemEvent)
      .where(
        and(
          eq(workItemEvent.id, sql`(${latestRestart})`),
          sql`(${workItemEvent.fromState} = 'merge_queue' OR (${workItemEvent.fromState} = 'verifying'
            AND (${enteredVerifyingFrom}) = 'merge_queue'))`,
        ),
      ),
  );
  return row !== undefined;
}

/**
 * Whether the task's latest restart sent it back to the agent from the merge queue, or from the
 * re-verify of a task in it: a CI, conflict, review or findings fix of a finished pull request.
 */
export async function restartedFromMergeQueue(store: Db, itemId: string): Promise<boolean> {
  return store.run((q) => restartedFromMergeQueueSteps(q, itemId));
}

export function* keepMergeQueuePlaceSteps(q: Q, itemId: string) {
  const { mergeQueueEntry } = q.t;
  yield* q.exec(
    q.orm.update(mergeQueueEntry).set({ kept: 1 }).where(eq(mergeQueueEntry.itemId, itemId)),
  );
}

/**
 * Keep the task's place while it goes back to the agent for a rebase. A halt leaves the kept
 * place alone, and the next Closeout acceptance returns the task to it.
 */
export async function keepMergeQueuePlace(store: Db, itemId: string): Promise<void> {
  await store.run((q) => keepMergeQueuePlaceSteps(q, itemId));
}

export function* releaseMergeQueuePlaceSteps(q: Q, itemId: string) {
  const { mergeQueueEntry } = q.t;
  yield* q.exec(
    q.orm
      .delete(mergeQueueEntry)
      .where(and(eq(mergeQueueEntry.itemId, itemId), eq(mergeQueueEntry.kept, 0))),
  );
}

/** Leave the queue unless the place is kept. */
export async function releaseMergeQueuePlace(store: Db, itemId: string): Promise<void> {
  await store.run((q) => releaseMergeQueuePlaceSteps(q, itemId));
}

export function* returnToMergeQueueSteps(q: Q, itemId: string) {
  const { mergeQueueEntry } = q.t;
  yield* releaseMergeQueuePlaceSteps(q, itemId);
  yield* q.exec(
    q.orm.update(mergeQueueEntry).set({ kept: 0 }).where(eq(mergeQueueEntry.itemId, itemId)),
  );
}

/** Closeout accepted a new head: back to a kept place, or out of the queue to join at the end. */
export async function returnToMergeQueue(store: Db, itemId: string): Promise<void> {
  await store.run((q) => returnToMergeQueueSteps(q, itemId));
}

export function* markMergeQueueNotifiedSteps(q: Q, itemId: string, position: number) {
  const { mergeQueueEntry } = q.t;
  yield* q.exec(
    q.orm
      .update(mergeQueueEntry)
      .set({ notifiedPosition: position })
      .where(eq(mergeQueueEntry.itemId, itemId)),
  );
}

export async function markMergeQueueNotified(
  store: Db,
  itemId: string,
  position: number,
): Promise<void> {
  await store.run((q) => markMergeQueueNotifiedSteps(q, itemId, position));
}

type MergeHeld = (q: Q, itemId: string) => Steps<boolean>;

export function* listMergeQueuesSteps(q: Q, held?: MergeHeld) {
  const { mergeQueueEntry, workItem } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        itemId: mergeQueueEntry.itemId,
        repository: mergeQueueEntry.repository,
        lane: mergeQueueEntry.lane,
        readyAt: mergeQueueEntry.readyAt,
        projectName: sql<
          string | null
        >`CASE WHEN ${workItem.linearProjectId} = ${mergeQueueEntry.lane} THEN ${workItem.linearProjectName} END`,
        notifiedPosition: mergeQueueEntry.notifiedPosition,
        state: workItem.state,
      })
      .from(mergeQueueEntry)
      .innerJoin(workItem, eq(workItem.id, mergeQueueEntry.itemId))
      .where(and(inArray(workItem.state, HOLDING), eq(workItem.cancelRequested, 0)))
      .orderBy(
        asc(mergeQueueEntry.repository),
        asc(mergeQueueEntry.lane),
        asc(mergeQueueEntry.readyAt),
        asc(mergeQueueEntry.id),
      ),
  );
  const byLane = new Map<string, typeof rows>();
  for (const row of rows) {
    if (held && (yield* held(q, row.itemId))) continue;
    const key = `${row.repository}\0${row.lane}`;
    byLane.set(key, [...(byLane.get(key) ?? []), row]);
  }
  return [...byLane.values()].flatMap((queue) =>
    queue.map(({ state, projectName: _, ...row }, index): MergeQueuePosition => ({
      ...row,
      laneName:
        row.lane === ""
          ? null
          : (queue.find((entry) => entry.projectName !== null)?.projectName ?? null),
      position: index + 1,
      total: queue.length,
      aheadItemId: queue[index - 1]?.itemId ?? null,
      busy: state !== "merge_queue",
      nextItemId:
        queue.slice(0, index).findLast((ahead) => ahead.state === "merge_queue")?.itemId ?? null,
    })),
  );
}

/**
 * Every lane of every queue, each in merge order. A task `held` says may not merge yet, such as one waiting for
 * its Linear dependencies, keeps its row and its `ready_at` but takes no place, so it blocks
 * nobody and returns to its place once released.
 */
export async function listMergeQueues(store: Db): Promise<MergeQueuePosition[]> {
  return store.run((q) => listMergeQueuesSteps(q));
}

export function* mergeQueuePositionSteps(
  q: Q,
  itemId: string,
  held?: MergeHeld,
): Steps<MergeQueuePosition | null> {
  return (yield* listMergeQueuesSteps(q, held)).find((entry) => entry.itemId === itemId) ?? null;
}

export async function mergeQueuePosition(
  store: Db,
  itemId: string,
): Promise<MergeQueuePosition | null> {
  return store.run((q) => mergeQueuePositionSteps(q, itemId));
}

export function* wakeMergesBehindSteps(q: Q, now: number) {
  const { job } = q.t;
  const least = q.dialect === "sqlite" ? sql`MIN` : sql`LEAST`;
  yield* q.exec(
    q.orm
      .update(job)
      .set({ runAt: sql`${least}(${job.runAt}, ${now})` })
      .where(
        and(
          eq(job.queue, JOB_KIND.merge),
          eq(job.status, "pending"),
          inArray(jsonField(q, job.payload, "mergeWait", "reason"), ["ahead", "dependencies"]),
        ),
      ),
  );
}

/** A holder departed or changed eligibility: parked followers check again now. */
export async function wakeMergesBehind(store: Db, now: number): Promise<void> {
  await store.run((q) => wakeMergesBehindSteps(q, now));
}

export function* mergeQueueReadyTimesSteps(q: Q) {
  const { mergeQueueEntry } = q.t;
  return yield* q.all(
    q.orm
      .select({ itemId: mergeQueueEntry.itemId, readyAt: mergeQueueEntry.readyAt })
      .from(mergeQueueEntry),
  );
}

export async function mergeQueueReadyTimes(
  store: Db,
): Promise<{ itemId: string; readyAt: number }[]> {
  return store.run((q) => mergeQueueReadyTimesSteps(q));
}
