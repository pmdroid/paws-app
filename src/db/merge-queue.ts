import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { orm } from "./orm";
import { job, mergeQueueEntry, workItem } from "./schema";

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

/**
 * Join the lane at the end, in the order tasks became ready. A task already in the queue keeps its
 * place and its lane. `lane` is a Linear project id, or `''` (the default) for the whole repository.
 */
export function joinMergeQueue(
  db: Database,
  input: { itemId: string; repository: string; lane?: string; now: number },
): void {
  orm(db)
    .insert(mergeQueueEntry)
    .values({
      itemId: input.itemId,
      repository: input.repository.toLowerCase(),
      lane: input.lane ?? "",
      readyAt: input.now,
    })
    .onConflictDoNothing()
    .run();
}

export function leaveMergeQueue(db: Database, itemId: string): void {
  orm(db).delete(mergeQueueEntry).where(eq(mergeQueueEntry.itemId, itemId)).run();
}

/** Whether the task holds a place in a merge queue: `merge_queue`, or `verifying` in it. */
export function inMergeQueue(db: Database, itemId: string): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(mergeQueueEntry)
      .innerJoin(workItem, eq(workItem.id, mergeQueueEntry.itemId))
      .where(
        and(
          eq(mergeQueueEntry.itemId, itemId),
          inArray(workItem.state, HOLDING),
          eq(workItem.cancelRequested, 0),
        ),
      )
      .get() !== undefined
  );
}

/**
 * Whether the task's latest restart sent it back to the agent from the merge queue, or from the
 * re-verify of a task in it: a CI, conflict, review or findings fix of a finished pull request.
 */
export function restartedFromMergeQueue(db: Database, itemId: string): boolean {
  return (
    orm(db).get(
      sql`SELECT 1 FROM work_item_event ev
         WHERE ev.id = (SELECT MAX(r.id) FROM work_item_event r WHERE r.item_id = ${itemId} AND r.kind = 'restart')
         AND (ev.from_state = 'merge_queue' OR (ev.from_state = 'verifying'
           AND (SELECT p.from_state FROM work_item_event p WHERE p.item_id = ${itemId} AND p.id < ev.id
             AND p.to_state = 'verifying' AND p.from_state <> 'verifying'
             ORDER BY p.id DESC LIMIT 1) = 'merge_queue'))`,
    ) !== undefined
  );
}

/**
 * Keep the task's place while it goes back to the agent for a rebase. A halt leaves the kept
 * place alone, and the next Closeout acceptance returns the task to it.
 */
export function keepMergeQueuePlace(db: Database, itemId: string): void {
  orm(db).update(mergeQueueEntry).set({ kept: 1 }).where(eq(mergeQueueEntry.itemId, itemId)).run();
}

/** Leave the queue unless the place is kept. */
export function releaseMergeQueuePlace(db: Database, itemId: string): void {
  orm(db)
    .delete(mergeQueueEntry)
    .where(and(eq(mergeQueueEntry.itemId, itemId), eq(mergeQueueEntry.kept, 0)))
    .run();
}

/** Closeout accepted a new head: back to a kept place, or out of the queue to join at the end. */
export function returnToMergeQueue(db: Database, itemId: string): void {
  releaseMergeQueuePlace(db, itemId);
  orm(db).update(mergeQueueEntry).set({ kept: 0 }).where(eq(mergeQueueEntry.itemId, itemId)).run();
}

export function markMergeQueueNotified(db: Database, itemId: string, position: number): void {
  orm(db)
    .update(mergeQueueEntry)
    .set({ notifiedPosition: position })
    .where(eq(mergeQueueEntry.itemId, itemId))
    .run();
}

/**
 * Every lane of every queue, each in merge order. A task `held` says may not merge yet, such as one waiting for
 * its Linear dependencies, keeps its row and its `ready_at` but takes no place, so it blocks
 * nobody and returns to its place once released.
 */
export function listMergeQueues(
  db: Database,
  held: (itemId: string) => boolean = () => false,
): MergeQueuePosition[] {
  const rows = orm(db)
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
    )
    .all();
  const byLane = new Map<string, typeof rows>();
  for (const row of rows.filter((entry) => !held(entry.itemId))) {
    const key = `${row.repository}\0${row.lane}`;
    byLane.set(key, [...(byLane.get(key) ?? []), row]);
  }
  return [...byLane.values()].flatMap((queue) =>
    queue.map(({ state, projectName: _, ...row }, index) => ({
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

export function mergeQueuePosition(
  db: Database,
  itemId: string,
  held?: (itemId: string) => boolean,
): MergeQueuePosition | null {
  return listMergeQueues(db, held).find((entry) => entry.itemId === itemId) ?? null;
}

/** A holder departed or changed eligibility: parked followers check again now. */
export function wakeMergesBehind(db: Database, now: number): void {
  orm(db)
    .update(job)
    .set({ runAt: sql`MIN(${job.runAt}, ${now})` })
    .where(
      and(
        eq(job.queue, JOB_KIND.merge),
        eq(job.status, "pending"),
        sql`json_extract(${job.payload}, '$.mergeWait.reason') IN ('ahead','dependencies')`,
      ),
    )
    .run();
}

export function mergeQueueReadyTimes(db: Database): { itemId: string; readyAt: number }[] {
  return orm(db)
    .select({ itemId: mergeQueueEntry.itemId, readyAt: mergeQueueEntry.readyAt })
    .from(mergeQueueEntry)
    .all();
}
