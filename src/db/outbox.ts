import type { Database } from "bun:sqlite";
import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  DEFAULT_LEASE_MS,
  retryBackoffMs,
} from "../core";
import { errorText } from "./jobs";

export const OUTBOX_TARGETS = ["linear", "slack", "github", "sandbox"] as const;
export type OutboxTarget = (typeof OUTBOX_TARGETS)[number];

export const OUTBOX_STATUSES = ["pending", "sent", "dead", "dropped"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;

export type NewOutbox = {
  target: OutboxTarget;
  op: string;
  idempotencyKey: string;
  payload?: unknown;
  orderingKey?: string;
  priority?: number;
  notBefore?: number;
  maxAttempts?: number;
  now?: number;
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
  maxAttempts: number;
  status: OutboxStatus;
  createdAt: number;
  sentAt: number | null;
  lockedBy: string | null;
  lockedUntil: number | null;
  error: string | null;
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
  max_attempts: number;
  status: OutboxStatus;
  created_at: number;
  sent_at: number | null;
  locked_by: string | null;
  locked_until: number | null;
  error: string | null;
};

export type OutboxClaimOptions = {
  workerId?: string;
  leaseMs?: number;
  now?: number;
  limit?: number;
};

/**
 * Insert in the same transaction as the transition that caused the effect.
 * A duplicate idempotency key throws; wake notes use {@link enqueueOutboxOnce}.
 */
export function enqueueOutbox(db: Database, row: NewOutbox): number {
  const inserted = insertOutbox(db, row);
  if (inserted === null) {
    throw new Error("enqueueOutbox did not return an id");
  }
  return inserted;
}

/** Store the row once. A repeat of the same idempotency key returns the original id. */
export function enqueueOutboxOnce(db: Database, row: NewOutbox): number {
  const inserted = insertOutbox(db, row, true);
  if (inserted !== null) return inserted;
  const existing = db
    .query<{ id: number }, [string]>("SELECT id FROM outbox WHERE idempotency_key = ?")
    .get(row.idempotencyKey);
  if (existing === null) {
    throw new Error("enqueueOutboxOnce did not store a row");
  }
  return existing.id;
}

export function getOutbox(db: Database, id: number): OutboxRow | null {
  const row = db.query<OutboxSqlRow, [number]>("SELECT * FROM outbox WHERE id = ?").get(id);
  return row === null ? null : mapOutbox(row);
}

export function listOutbox(db: Database, orderingKey?: string): OutboxRow[] {
  if (orderingKey === undefined) {
    return db.query<OutboxSqlRow, []>("SELECT * FROM outbox ORDER BY id").all().map(mapOutbox);
  }
  return db
    .query<OutboxSqlRow, [string]>("SELECT * FROM outbox WHERE ordering_key = ? ORDER BY id")
    .all(orderingKey)
    .map(mapOutbox);
}

/**
 * Claim the ready head of each ordering key. A dead or in-flight head blocks
 * only that key. Rows with a null ordering key are independent.
 * Status stays `pending` while the lease is held; 001 has no inflight status.
 */
export function claimOutboxHeads(db: Database, options: OutboxClaimOptions = {}): OutboxRow[] {
  const now = options.now ?? Date.now();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const workerId = options.workerId ?? "outbox";
  const limit = options.limit ?? 32;
  const rows = db
    .query<OutboxSqlRow, [string, number, number, number, number]>(
      `WITH heads AS (
         SELECT MIN(id) AS id
         FROM outbox
         WHERE status NOT IN ('sent', 'dropped') AND ordering_key IS NOT NULL
         GROUP BY ordering_key
         UNION ALL
         SELECT id FROM outbox
         WHERE status NOT IN ('sent', 'dropped') AND ordering_key IS NULL
       )
       UPDATE outbox
       SET locked_by = ?,
           locked_until = ?,
           attempts = attempts + 1
       WHERE id IN (
         SELECT outbox.id
         FROM outbox
         JOIN heads ON heads.id = outbox.id
         WHERE outbox.status = 'pending'
           AND outbox.not_before <= ?
           AND (outbox.locked_until IS NULL OR outbox.locked_until <= ?)
         ORDER BY outbox.priority ASC, outbox.id ASC
         LIMIT ?
       )
       RETURNING *`,
    )
    .all(workerId, now + leaseMs, now, now, limit);
  return rows.map(mapOutbox);
}

export function completeOutbox(db: Database, row: OutboxRow, now = Date.now()): boolean {
  const result = db.run(
    `UPDATE outbox
     SET status = 'sent', sent_at = ?, locked_by = NULL, locked_until = NULL, error = NULL
     WHERE id = ? AND status = 'pending' AND locked_by = ?`,
    [now, row.id, row.lockedBy],
  );
  return result.changes > 0;
}

export function retryOutbox(
  db: Database,
  row: OutboxRow,
  error: unknown,
  options: { now?: number; baseMs?: number; capMs?: number } = {},
): void {
  const now = options.now ?? Date.now();
  const delay = retryBackoffMs(
    row.attempts,
    options.baseMs ?? DEFAULT_BACKOFF_BASE_MS,
    options.capMs ?? DEFAULT_BACKOFF_CAP_MS,
  );
  db.run(
    `UPDATE outbox
     SET status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
         not_before = CASE WHEN attempts >= max_attempts THEN not_before ELSE ? END,
         locked_by = NULL,
         locked_until = NULL,
         error = ?
     WHERE id = ? AND status = 'pending' AND locked_by = ?`,
    [now + delay, errorText(error), row.id, row.lockedBy],
  );
}

export type DispatchOptions = OutboxClaimOptions & {
  deliver?: (row: OutboxRow) => void;
};

/** Claim ready heads and, when `deliver` is set, mark each sent or schedule a retry. */
export function dispatchOutbox(db: Database, options: DispatchOptions = {}): OutboxRow[] {
  const claimed = claimOutboxHeads(db, options);
  const deliver = options.deliver;
  if (deliver === undefined) return claimed;
  for (const row of claimed) {
    try {
      deliver(row);
      completeOutbox(db, row, options.now);
    } catch (error) {
      retryOutbox(db, row, error, { now: options.now });
    }
  }
  return claimed;
}

function insertOutbox(db: Database, row: NewOutbox, ignore = false): number | null {
  const now = row.now ?? Date.now();
  const verb = ignore ? "INSERT OR IGNORE" : "INSERT";
  const inserted = db
    .query<
      { id: number },
      [string, string, string | null, string, string, number, number, number, number]
    >(
      `${verb} INTO outbox (
         target, op, ordering_key, idempotency_key, payload, priority, not_before, created_at, max_attempts
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      now,
      row.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS,
    );
  return inserted?.id ?? null;
}

function mapOutbox(row: OutboxSqlRow): OutboxRow {
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
    maxAttempts: row.max_attempts,
    status: row.status,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    lockedBy: row.locked_by,
    lockedUntil: row.locked_until,
    error: row.error,
  };
}
