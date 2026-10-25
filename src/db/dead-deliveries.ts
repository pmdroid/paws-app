import type { Database } from "bun:sqlite";
import { journal } from "./journal";
import { DEFAULT_OUTBOX_MAX_ATTEMPTS, OUTBOX_ITEM_SQL } from "./outbox";
import { immediate } from "./tx";

/** A dead outbox row or a dead job of one work item. */
export type DeadDelivery = {
  kind: "outbox" | "job";
  id: number;
  /** `target.op` for an outbox row, the queue for a job. */
  name: string;
  error: string | null;
  attempts: number;
  createdAt: number;
  /** When the row or job last moved: a job's finish, else its creation. */
  at: number;
};

export type DeadDeliveryRef = { kind: "outbox" | "job"; id: number };

/** Dead outbox rows and dead jobs of one work item, oldest first. */
export function listDeadDeliveries(db: Database, itemId: string): DeadDelivery[] {
  const outbox = db
    .query<
      { id: number; name: string; error: string | null; attempts: number; created_at: number },
      [string]
    >(
      `SELECT o.id, o.target || '.' || o.op AS name, o.error, o.attempts, o.created_at
       FROM outbox o WHERE o.status = 'dead' AND ${OUTBOX_ITEM_SQL("o")} = ? ORDER BY o.id`,
    )
    .all(itemId)
    .map((row): DeadDelivery => ({
      kind: "outbox",
      id: row.id,
      name: row.name,
      error: row.error,
      attempts: row.attempts,
      createdAt: row.created_at,
      at: row.created_at,
    }));
  const jobs = db
    .query<
      {
        id: number;
        queue: string;
        last_error: string | null;
        attempts: number;
        created_at: number;
        finished_at: number | null;
      },
      [string]
    >(
      `SELECT id, queue, last_error, attempts, created_at, finished_at FROM job
       WHERE status = 'dead' AND json_extract(payload, '$.itemId') = ? ORDER BY id`,
    )
    .all(itemId)
    .map((row): DeadDelivery => ({
      kind: "job",
      id: row.id,
      name: row.queue,
      error: row.last_error,
      attempts: row.attempts,
      createdAt: row.created_at,
      at: row.finished_at ?? row.created_at,
    }));
  return [...outbox, ...jobs].sort((left, right) => left.at - right.at || left.id - right.id);
}

/**
 * Put one dead row or job of the item back to pending, due now, with a fresh attempt budget.
 * Returns false when it is not dead or belongs to another item.
 */
export function retryDeadDelivery(
  db: Database,
  itemId: string,
  ref: DeadDeliveryRef,
  now = Date.now(),
): boolean {
  return immediate(db, () => {
    const result =
      ref.kind === "outbox"
        ? db.run(
            `UPDATE outbox SET status = 'pending', max_attempts = attempts + ?, not_before = ?,
               locked_by = NULL, locked_until = NULL
             WHERE id = ? AND status = 'dead' AND ${OUTBOX_ITEM_SQL("outbox")} = ?`,
            [DEFAULT_OUTBOX_MAX_ATTEMPTS, now, ref.id, itemId],
          )
        : db.run(
            `UPDATE job SET status = 'pending', attempts = 0, run_at = ?, finished_at = NULL,
               locked_by = NULL, locked_until = NULL
             WHERE id = ? AND status = 'dead' AND json_extract(payload, '$.itemId') = ?`,
            [now, ref.id, itemId],
          );
    if (result.changes === 0) return false;
    journal(`${ref.kind} ${ref.id} retried item=${itemId}`);
    return true;
  });
}
