import type { Database } from "bun:sqlite";
import { NotImplementedError } from "../core";

export const OUTBOX_TARGETS = ["linear", "slack", "github", "sandbox"] as const;
export type OutboxTarget = (typeof OUTBOX_TARGETS)[number];

export const OUTBOX_STATUSES = ["pending", "sent", "dead", "dropped"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export type NewOutbox = {
  target: OutboxTarget;
  op: string;
  idempotencyKey: string;
  payload?: unknown;
  orderingKey?: string;
  priority?: number;
  notBefore?: number;
};

export type OutboxRow = {
  id: number;
  target: OutboxTarget;
  op: string;
  orderingKey: string | null;
  idempotencyKey: string;
  payload: unknown;
  priority: number;
  notBefore: number;
  attempts: number;
  status: OutboxStatus;
  createdAt: number;
  sentAt: number | null;
};

type OutboxSqlRow = {
  id: number;
  target: OutboxTarget;
  op: string;
  ordering_key: string | null;
  idempotency_key: string;
  payload: string;
  priority: number;
  not_before: number;
  attempts: number;
  status: OutboxStatus;
  created_at: number;
  sent_at: number | null;
};

/** Insert in the same transaction as the transition that caused the effect. */
export function enqueueOutbox(db: Database, row: NewOutbox): number {
  const inserted = db
    .query<{ id: number }, [string, string, string | null, string, string, number, number, number]>(
      `INSERT INTO outbox (target, op, ordering_key, idempotency_key, payload, priority, not_before, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`,
    )
    .get(
      row.target,
      row.op,
      row.orderingKey ?? null,
      row.idempotencyKey,
      JSON.stringify(row.payload ?? {}),
      row.priority ?? 5,
      row.notBefore ?? 0,
      Date.now(),
    );
  if (inserted === null) {
    throw new Error("enqueueOutbox did not return an id");
  }
  return inserted.id;
}

export function getOutbox(db: Database, id: number): OutboxRow | null {
  const row = db.query<OutboxSqlRow, [number]>("SELECT * FROM outbox WHERE id = ?").get(id);
  if (row === null) return null;
  return {
    id: row.id,
    target: row.target,
    op: row.op,
    orderingKey: row.ordering_key,
    idempotencyKey: row.idempotency_key,
    payload: JSON.parse(row.payload) as unknown,
    priority: row.priority,
    notBefore: row.not_before,
    attempts: row.attempts,
    status: row.status,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

/** QM-03 / the activity dispatcher sends pending rows. This stub fails closed. */
export function dispatchOutbox(db: Database): void {
  void db;
  throw new NotImplementedError("outbox dispatch");
}
