import type { Database } from "bun:sqlite";
import { and, desc, eq, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import { jsonItemId } from "./jobs";
import { journal } from "./journal";
import {
  DEFAULT_OUTBOX_MAX_ATTEMPTS,
  ELICITATION_REASK_SUFFIX,
  enqueueOutboxOnceSteps,
  OUTBOX_ITEM_SQL,
  type OutboxDelivery,
} from "./outbox";

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

function jsonField(q: Q, column: AnyColumn, key: string): SQL<string | null> {
  return q.dialect === "sqlite"
    ? sql`json_extract(${column}, ${`$.${key}`})`
    : sql`(${column}->>${key})`;
}

/** A job is current while the item still has the version the job was captured at. */
function jobCurrent(q: Q): SQL {
  const { job, workItem } = q.t;
  return sql`(${job.itemVersion} IS NULL OR ${job.itemVersion} =
    (SELECT ${workItem.version} FROM ${workItem} WHERE ${workItem.id} = ${jsonItemId(q, sql`${job.payload}`)}))`;
}

function outboxItem(q: Q): SQL<string | null> {
  return sql<string | null>`${sql.raw(OUTBOX_ITEM_SQL("outbox", q.dialect))}`;
}

/** Dead outbox rows and dead jobs of one work item, oldest first. */
export function listDeadDeliveries(db: Database, itemId: string): DeadDelivery[] {
  return settled(sqliteDb(db).run((q) => listDeadDeliveriesSteps(q, itemId)));
}

export function* listDeadDeliveriesSteps(q: Q, itemId: string) {
  const { outbox, job } = q.t;
  const outboxRows = (yield* q.all(
    q.orm
      .select({
        id: outbox.id,
        name: sql<string>`${outbox.target} || '.' || ${outbox.op}`,
        error: outbox.error,
        attempts: outbox.attempts,
        createdAt: outbox.createdAt,
      })
      .from(outbox)
      .where(and(eq(outbox.status, "dead"), sql`${outboxItem(q)} = ${itemId}`))
      .orderBy(outbox.id),
  )).map((row): DeadDelivery => ({
    kind: "outbox",
    ...row,
    at: row.createdAt,
    retryable: true,
  }));
  const jobs = (yield* q.all(
    q.orm
      .select({
        id: job.id,
        queue: job.queue,
        lastError: job.lastError,
        attempts: job.attempts,
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
        current: sql<number>`CASE WHEN ${jobCurrent(q)} THEN 1 ELSE 0 END`,
      })
      .from(job)
      .where(and(eq(job.status, "dead"), eq(jsonItemId(q, sql`${job.payload}`), itemId)))
      .orderBy(job.id),
  )).map((row): DeadDelivery => ({
    kind: "job",
    id: row.id,
    name: row.queue,
    error: row.lastError,
    attempts: row.attempts,
    createdAt: row.createdAt,
    at: row.finishedAt ?? row.createdAt,
    retryable: Number(row.current) === 1,
  }));
  return [...outboxRows, ...jobs].sort((left, right) => left.at - right.at || left.id - right.id);
}

/** The work item a dead row or job belongs to, or null when it is not dead or has no item. */
export function deadDeliveryItemId(db: Database, ref: DeadDeliveryRef): string | null {
  return settled(sqliteDb(db).run((q) => deadDeliveryItemIdSteps(q, ref)));
}

export function* deadDeliveryItemIdSteps(q: Q, ref: DeadDeliveryRef) {
  const { outbox, job } = q.t;
  const row =
    ref.kind === "outbox"
      ? yield* q.one(
          q.orm
            .select({ itemId: outboxItem(q) })
            .from(outbox)
            .where(and(eq(outbox.id, ref.id), eq(outbox.status, "dead"))),
        )
      : yield* q.one(
          q.orm
            .select({ itemId: jsonItemId(q, sql`${job.payload}`) })
            .from(job)
            .where(and(eq(job.id, ref.id), eq(job.status, "dead"))),
        );
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
  return settled(sqliteDb(db).transaction((q) => retryDeadDeliverySteps(q, itemId, ref, now)));
}

export function* retryDeadDeliverySteps(
  q: Q,
  itemId: string,
  ref: DeadDeliveryRef,
  now = Date.now(),
) {
  const { outbox, job } = q.t;
  const changed =
    ref.kind === "outbox"
      ? (yield* q.all(
          q.orm
            .update(outbox)
            .set({
              status: "pending",
              maxAttempts: sql`${outbox.attempts} + ${DEFAULT_OUTBOX_MAX_ATTEMPTS}`,
              notBefore: now,
              lockedBy: null,
              lockedUntil: null,
            })
            .where(
              and(
                eq(outbox.id, ref.id),
                eq(outbox.status, "dead"),
                sql`${outboxItem(q)} = ${itemId}`,
              ),
            )
            .returning({ id: outbox.id }),
        )).length
      : (yield* q.all(
          q.orm
            .update(job)
            .set({
              status: "pending",
              attempts: 0,
              runAt: now,
              finishedAt: null,
              lockedBy: null,
              lockedUntil: null,
            })
            .where(
              and(
                eq(job.id, ref.id),
                eq(job.status, "dead"),
                eq(jsonItemId(q, sql`${job.payload}`), itemId),
                jobCurrent(q),
              ),
            )
            .returning({ id: job.id }),
        )).length;
  if (changed === 0) return false;
  journal(`${ref.kind} ${ref.id} retried item=${itemId}`);
  return true;
}

/** Drop the dead elicitation rows of a question that was asked again, so the page stops listing them. */
export function dropDeadElicitations(db: Database, questionId: string, note: string): number {
  return settled(sqliteDb(db).run((q) => dropDeadElicitationsSteps(q, questionId, note)));
}

export function* dropDeadElicitationsSteps(q: Q, questionId: string, note: string) {
  const { outbox } = q.t;
  const dropped = yield* q.all(
    q.orm
      .update(outbox)
      .set({ status: "dropped", error: sql`COALESCE(${outbox.error} || ' ', '') || ${note}` })
      .where(
        and(
          eq(outbox.target, "linear"),
          eq(outbox.op, "elicitation"),
          eq(outbox.status, "dead"),
          eq(jsonField(q, outbox.payload, "questionId"), questionId),
        ),
      )
      .returning({ id: outbox.id }),
  );
  return dropped.length;
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
  { table: "risk_fix", column: "approved_question_id" },
  { table: "push_outage", column: "question_id" },
  { table: "closeout_policy_outage", column: "question_id" },
  { table: "closeout_policy_block", column: "question_id" },
] as const;

/** True when another record is tied to this question's id. */
export function questionHasLinkedRecords(db: Database, questionId: string): boolean {
  return settled(sqliteDb(db).run((q) => questionHasLinkedRecordsSteps(q, questionId)));
}

export function* questionHasLinkedRecordsSteps(q: Q, questionId: string) {
  const links = QUESTION_LINKS.map(
    ({ table, column }) =>
      sql`SELECT 1 FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${questionId}`,
  );
  const linked = yield* q.one(
    q.orm
      .select({ one: sql<number>`1` })
      .from(sql`(${sql.join(links, sql` UNION ALL `)}) AS link`)
      .limit(1),
  );
  return linked !== undefined;
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
  return settled(sqliteDb(db).transaction((q) => redeliverQuestionSteps(q, questionId, now)));
}

export function* redeliverQuestionSteps(q: Q, questionId: string, now: number) {
  const { outbox } = q.t;
  const last = yield* q.one(
    q.orm
      .select({
        op: outbox.op,
        orderingKey: outbox.orderingKey,
        payload: outbox.payload,
        priority: outbox.priority,
        idempotencyKey: outbox.idempotencyKey,
        deliveryKind: outbox.deliveryKind,
        deliveryGeneration: outbox.deliveryGeneration,
      })
      .from(outbox)
      .where(
        and(
          eq(outbox.target, "linear"),
          eq(outbox.op, "elicitation"),
          eq(jsonField(q, outbox.payload, "questionId"), questionId),
        ),
      )
      .orderBy(desc(outbox.id))
      .limit(1),
  );
  if (last === undefined || last.orderingKey === null) return null;
  const base = last.idempotencyKey.replace(/(:redelivery|:reask)+$/, "");
  const id = yield* enqueueOutboxOnceSteps(q, {
    target: "linear",
    op: last.op,
    orderingKey: last.orderingKey,
    idempotencyKey: `${base}${ELICITATION_REASK_SUFFIX}`,
    payload:
      q.dialect === "sqlite" ? (JSON.parse(last.payload as string) as unknown) : last.payload,
    priority: last.priority,
    delivery: last.deliveryKind as OutboxDelivery,
    generation: last.deliveryGeneration,
    now,
  });
  const queued = yield* q.one(
    q.orm
      .select({ status: outbox.status, error: outbox.error })
      .from(outbox)
      .where(eq(outbox.id, id)),
  );
  if (queued?.status !== "pending") {
    journal(
      `question ${questionId} could not be delivered again: ${queued?.error ?? "not queued"}; retry it from the issue page`,
    );
    return null;
  }
  yield* dropDeadElicitationsSteps(q, questionId, `Delivered again as outbox ${id}.`);
  journal(`question ${questionId} delivered again as outbox ${id}`);
  return id;
}

/**
 * True for a dead final Stop delivery. Its session is stopped by design, so retrying it must
 * not require a running session, unlike every other retry.
 */
export function deadDeliveryIsFinalStop(db: Database, ref: DeadDeliveryRef): boolean {
  return settled(sqliteDb(db).run((q) => deadDeliveryIsFinalStopSteps(q, ref)));
}

export function* deadDeliveryIsFinalStopSteps(q: Q, ref: DeadDeliveryRef) {
  if (ref.kind !== "outbox") return false;
  const { outbox } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: outbox.id })
      .from(outbox)
      .where(
        and(eq(outbox.id, ref.id), eq(outbox.status, "dead"), eq(outbox.deliveryKind, "stop")),
      ),
  );
  return row !== undefined;
}

/**
 * Remember which question a re-ask job produced, so a death of that question counts against
 * the same lineage instead of starting a new allowance.
 */
export function recordQuestionReask(db: Database, jobId: number, questionId: string): void {
  settled(sqliteDb(db).run((q) => recordQuestionReaskSteps(q, jobId, questionId)));
}

export function* recordQuestionReaskSteps(q: Q, jobId: number, questionId: string) {
  const { job } = q.t;
  yield* q.exec(
    q.orm
      .update(job)
      .set({
        payload:
          q.dialect === "sqlite"
            ? sql`json_set(${job.payload}, '$.reaskedAs', ${questionId})`
            : sql`jsonb_set(${job.payload}, '{reaskedAs}', to_jsonb(${questionId}::text))`,
      })
      .where(eq(job.id, jobId)),
  );
}
