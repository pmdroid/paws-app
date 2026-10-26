import type { Database } from "bun:sqlite";
import { journal } from "./journal";
import {
  DEFAULT_OUTBOX_MAX_ATTEMPTS,
  ELICITATION_REASK_SUFFIX,
  enqueueOutboxOnce,
  OUTBOX_ITEM_SQL,
  type OutboxDelivery,
} from "./outbox";
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
  /**
   * False for a job captured at an older item version: its payload describes work the item
   * has moved past (a restart, an answer, a stop), so retrying it would revive that work.
   */
  retryable: boolean;
};

export type DeadDeliveryRef = { kind: "outbox" | "job"; id: number };

/** A job is current while the item still has the version the job was captured at. */
const JOB_CURRENT_SQL = `(job.item_version IS NULL OR job.item_version =
  (SELECT version FROM work_item WHERE id = json_extract(job.payload, '$.itemId')))`;

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
      retryable: true,
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
        current: number;
      },
      [string]
    >(
      `SELECT id, queue, last_error, attempts, created_at, finished_at, ${JOB_CURRENT_SQL} AS current
       FROM job WHERE status = 'dead' AND json_extract(payload, '$.itemId') = ? ORDER BY id`,
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
      retryable: row.current === 1,
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
 * Returns false when it is not dead, belongs to another item, or is a job captured at an
 * older item version: that job's work is obsolete and retrying it would revive it.
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
             WHERE id = ? AND status = 'dead' AND json_extract(payload, '$.itemId') = ?
               AND ${JOB_CURRENT_SQL}`,
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

/**
 * Tables that tie a record to a question id. Answering such a question reads that record by
 * the question's id, so it cannot be replaced by a new question; it is delivered again instead.
 * A schema test keeps this list in step with every question id column.
 */
export const QUESTION_LINKS = [
  { table: "closeout_recovery", column: "question_id" },
  { table: "work_item_repository_question", column: "question_id" },
  { table: "github_integration_hold", column: "question_id" },
  { table: "decision_memory", column: "question_id" },
  { table: "decision_suggestion", column: "question_id" },
  { table: "visual_review", column: "question_id" },
  { table: "visual_review_mark", column: "question_id" },
  { table: "plan_proposal", column: "question_id" },
  { table: "link_ask", column: "question_id" },
  { table: "closeout_bypass_check", column: "question_id" },
] as const;

/** True when another record is tied to this question's id. */
export function questionHasLinkedRecords(db: Database, questionId: string): boolean {
  const sql = QUESTION_LINKS.map(
    ({ table, column }) => `SELECT 1 FROM ${table} WHERE ${column} = ?1`,
  ).join(" UNION ALL ");
  return db.query<{ 1: number }, [string]>(`${sql} LIMIT 1`).get(questionId) !== null;
}

/**
 * Deliver an open question once more under a fresh key, keeping its id, its delivery kind and
 * its session generation, and drop its dead rows once the new delivery is pending.
 * Used for a question with linked records, which cannot be replaced by a new question.
 * Returns the new outbox id, or null when nothing could be queued: the question has no earlier
 * elicitation, or the session fence rejected the delivery. Its dead rows then stay listed on
 * the issue page with a retry, so the item is never left waiting on nothing visible.
 */
export function redeliverQuestion(db: Database, questionId: string, now: number): number | null {
  return immediate(db, () => {
    const last = db
      .query<
        {
          op: string;
          ordering_key: string | null;
          payload: string;
          priority: number;
          idempotency_key: string;
          delivery_kind: OutboxDelivery;
          delivery_generation: number;
        },
        [string]
      >(
        `SELECT op, ordering_key, payload, priority, idempotency_key, delivery_kind, delivery_generation
         FROM outbox
         WHERE target = 'linear' AND op = 'elicitation' AND json_extract(payload, '$.questionId') = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(questionId);
    if (last === null || last.ordering_key === null) return null;
    const base = last.idempotency_key.replace(/(:redelivery|:reask)+$/, "");
    const id = enqueueOutboxOnce(db, {
      target: "linear",
      op: last.op,
      orderingKey: last.ordering_key,
      idempotencyKey: `${base}${ELICITATION_REASK_SUFFIX}`,
      payload: JSON.parse(last.payload) as unknown,
      priority: last.priority,
      delivery: last.delivery_kind,
      generation: last.delivery_generation,
      now,
    });
    const queued = db
      .query<{ status: string; error: string | null }, [number]>(
        "SELECT status, error FROM outbox WHERE id = ?",
      )
      .get(id);
    if (queued?.status !== "pending") {
      journal(
        `question ${questionId} could not be delivered again: ${queued?.error ?? "not queued"}; retry it from the issue page`,
      );
      return null;
    }
    dropDeadElicitations(db, questionId, `Delivered again as outbox ${id}.`);
    journal(`question ${questionId} delivered again as outbox ${id}`);
    return id;
  });
}

/**
 * True for a dead final Stop delivery. Its session is stopped by design, so retrying it must
 * not require a running session, unlike every other retry.
 */
export function deadDeliveryIsFinalStop(db: Database, ref: DeadDeliveryRef): boolean {
  if (ref.kind !== "outbox") return false;
  return (
    db
      .query<{ id: number }, [number]>(
        "SELECT id FROM outbox WHERE id = ? AND status = 'dead' AND delivery_kind = 'stop'",
      )
      .get(ref.id) !== null
  );
}

/**
 * Remember which question a re-ask job produced, so a death of that question counts against
 * the same lineage instead of starting a new allowance.
 */
export function recordQuestionReask(db: Database, jobId: number, questionId: string): void {
  db.run(`UPDATE job SET payload = json_set(payload, '$.reaskedAs', ?) WHERE id = ?`, [
    questionId,
    jobId,
  ]);
}
