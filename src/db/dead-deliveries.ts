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

/** The work item a dead row or job belongs to, or null when it is not dead or has no item. */
export function deadDeliveryItemId(db: Database, ref: DeadDeliveryRef): string | null {
  const row =
    ref.kind === "outbox"
      ? db
          .query<{ itemId: string | null }, [number]>(
            `SELECT ${OUTBOX_ITEM_SQL("o")} AS itemId FROM outbox o WHERE o.id = ? AND o.status = 'dead'`,
          )
          .get(ref.id)
      : db
          .query<{ itemId: string | null }, [number]>(
            `SELECT json_extract(payload, '$.itemId') AS itemId FROM job WHERE id = ? AND status = 'dead'`,
          )
          .get(ref.id);
  return typeof row?.itemId === "string" ? row.itemId : null;
}

/** Parse `outbox:12` or `job:7`, the form the issue page sends. */
export function parseDeadDeliveryRef(value: unknown): DeadDeliveryRef | null {
  if (typeof value !== "string") return null;
  const match = /^(outbox|job):([1-9][0-9]{0,15})$/.exec(value);
  if (match === null) return null;
  const id = Number(match[2]);
  return Number.isSafeInteger(id) ? { kind: match[1] as DeadDeliveryRef["kind"], id } : null;
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
               locked_by = NULL, locked_until = NULL,
               item_version = (SELECT version FROM work_item WHERE id = json_extract(job.payload, '$.itemId'))
             WHERE id = ? AND status = 'dead' AND json_extract(payload, '$.itemId') = ?`,
            [now, ref.id, itemId],
          );
    if (result.changes === 0) return false;
    journal(`${ref.kind} ${ref.id} retried item=${itemId}`);
    return true;
  });
}

/** Drop the dead elicitation rows of a question that was asked again, so the page stops listing them. */
export function dropDeadElicitations(db: Database, questionId: string, note: string): number {
  return db.run(
    `UPDATE outbox SET status = 'dropped', error = COALESCE(error || ' ', '') || ?
     WHERE target = 'linear' AND op = 'elicitation' AND status = 'dead'
       AND json_extract(payload, '$.questionId') = ?`,
    [note, questionId],
  ).changes;
}
