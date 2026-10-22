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

export function markMergeQueueNotified(db: Database, itemId: string, position: number): void {
  db.run("UPDATE merge_queue_entry SET notified_position=? WHERE item_id=?", [position, itemId]);
}

/** Every queue, each in merge order. */
export function listMergeQueues(db: Database): MergeQueuePosition[] {
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
  for (const row of rows)
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

export function mergeQueuePosition(db: Database, itemId: string): MergeQueuePosition | null {
  return listMergeQueues(db).find((entry) => entry.itemId === itemId) ?? null;
}
