import type { Database } from "bun:sqlite";

/**
 * A task's place in its repository's merge queue. 1 moves; the others wait. Only tasks in
 * `merge_queue`, or `verifying` while the first one runs Closeout again, hold a place, so a task
 * that went back to the agent, waits for an answer, or ended blocks nobody.
 */
export type MergeQueuePosition = {
  itemId: string;
  repository: string;
  /** 1 is the pull request that moves. */
  position: number;
  total: number;
  readyAt: number;
  /** The task in front of this one, or null for the first. */
  aheadItemId: string | null;
  /** The position Linear was last told about, or null. */
  notifiedPosition: number | null;
};

const HOLDING = "('merge_queue','verifying')";

/** Join at the end, in the order tasks became ready. A task already in the queue keeps its place. */
export function joinMergeQueue(
  db: Database,
  input: { itemId: string; repository: string; now: number },
): void {
  db.run("INSERT OR IGNORE INTO merge_queue_entry(item_id,repository,ready_at) VALUES(?,?,?)", [
    input.itemId,
    input.repository,
    input.now,
  ]);
}

export function leaveMergeQueue(db: Database, itemId: string): void {
  db.run("DELETE FROM merge_queue_entry WHERE item_id=?", [itemId]);
}

/** Whether the task holds a place in a merge queue: `merge_queue`, or `verifying` in it. */
export function inMergeQueue(db: Database, itemId: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM merge_queue_entry e JOIN work_item w ON w.id = e.item_id
         WHERE e.item_id = ? AND w.state IN ${HOLDING} AND w.cancel_requested = 0`,
      )
      .get(itemId) !== null
  );
}

/**
 * Whether the task's latest restart sent it back to the agent from the merge queue, or from the
 * re-verify of a task in it: a CI, conflict, review or findings fix of a finished pull request.
 */
export function restartedFromMergeQueue(db: Database, itemId: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM work_item_event ev
         WHERE ev.id = (SELECT MAX(r.id) FROM work_item_event r WHERE r.item_id = ?1 AND r.kind = 'restart')
         AND (ev.from_state = 'merge_queue' OR (ev.from_state = 'verifying'
           AND (SELECT p.from_state FROM work_item_event p WHERE p.item_id = ?1 AND p.id < ev.id
             AND p.to_state = 'verifying' AND p.from_state <> 'verifying'
             ORDER BY p.id DESC LIMIT 1) = 'merge_queue'))`,
      )
      .get(itemId) !== null
  );
}

/**
 * Keep the task's place while it goes back to the agent for a rebase. A halt leaves the kept
 * place alone, and the next Closeout acceptance returns the task to it.
 */
export function keepMergeQueuePlace(db: Database, itemId: string): void {
  db.run("UPDATE merge_queue_entry SET kept=1 WHERE item_id=?", [itemId]);
}

/** Leave the queue unless the place is kept. */
export function releaseMergeQueuePlace(db: Database, itemId: string): void {
  db.run("DELETE FROM merge_queue_entry WHERE item_id=? AND kept=0", [itemId]);
}

/** Closeout accepted a new head: back to a kept place, or out of the queue to join at the end. */
export function returnToMergeQueue(db: Database, itemId: string): void {
  releaseMergeQueuePlace(db, itemId);
  db.run("UPDATE merge_queue_entry SET kept=0 WHERE item_id=?", [itemId]);
}

export function markMergeQueueNotified(db: Database, itemId: string, position: number): void {
  db.run("UPDATE merge_queue_entry SET notified_position=? WHERE item_id=?", [position, itemId]);
}

/**
 * Every queue, each in merge order. A task `held` says may not merge yet, such as one waiting for
 * its Linear dependencies, keeps its row and its `ready_at` but takes no place, so it blocks
 * nobody and returns to its place once released.
 */
export function listMergeQueues(
  db: Database,
  held: (itemId: string) => boolean = () => false,
): MergeQueuePosition[] {
  const rows = db
    .query<
      {
        itemId: string;
        repository: string;
        readyAt: number;
        notifiedPosition: number | null;
      },
      []
    >(
      `SELECT e.item_id AS itemId, e.repository, e.ready_at AS readyAt,
              e.notified_position AS notifiedPosition
       FROM merge_queue_entry e JOIN work_item w ON w.id = e.item_id
       WHERE w.state IN ${HOLDING} AND w.cancel_requested = 0
       ORDER BY e.repository, e.ready_at, e.id`,
    )
    .all();
  const byRepository = new Map<string, typeof rows>();
  for (const row of rows.filter((entry) => !held(entry.itemId)))
    byRepository.set(row.repository, [...(byRepository.get(row.repository) ?? []), row]);
  return [...byRepository.values()].flatMap((queue) =>
    queue.map((row, index) => ({
      ...row,
      position: index + 1,
      total: queue.length,
      aheadItemId: queue[index - 1]?.itemId ?? null,
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
