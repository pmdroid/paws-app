import type { Database } from "bun:sqlite";
import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  DEFAULT_LEASE_MS,
  retryBackoffMs,
} from "../core";
import { errorText } from "./jobs";
import { immediate } from "./tx";

export const OUTBOX_TARGETS = ["linear", "slack", "github"] as const;
export type OutboxTarget = (typeof OUTBOX_TARGETS)[number];

export const OUTBOX_STATUSES = ["pending", "sent", "dead", "dropped"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;
export const LINEAR_PROGRESS_INTERVAL_MS = 30_000;

const PROGRESS_SQL = (row: string) =>
  `(${row}.target='linear' AND ${row}.delivery_kind='progress'
    AND ${row}.op IN ('activity','linear.activity')
    AND COALESCE(json_extract(${row}.payload,'$.kind'),'') IN ('thought','action'))`;

export type OutboxDelivery = "ordered" | "progress" | "critical" | "terminal" | "stop" | "status";

export type NewOutbox = {
  delivery?: OutboxDelivery;
  generation?: number;
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
  delivery?: OutboxDelivery;
  generation?: number;
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
  delivery_kind: OutboxDelivery;
  delivery_generation: number;
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
  blockedKeys?: readonly string[];
  progressIntervalMs?: number;
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
    .query<OutboxSqlRow, [string, number, string, number, number, number, number, number]>(
      `WITH ranked AS (
       SELECT o.id, ROW_NUMBER() OVER (
         PARTITION BY o.target, COALESCE('key:' || o.ordering_key, 'row:' || o.id)
         ORDER BY CASE WHEN o.target='linear' AND (
           o.delivery_kind IN ('terminal','status') OR o.op='elicitation'
         ) THEN 5 ELSE o.priority END, o.id
       ) AS position
       FROM outbox o
       LEFT JOIN outbox_session_fence f ON f.target = o.target AND f.ordering_key = o.ordering_key
       WHERE o.status NOT IN ('sent', 'dropped')
         AND o.delivery_generation = COALESCE(f.generation, 0)
         AND (COALESCE(f.stopped, 0) = 0 OR o.delivery_kind = 'stop')
         AND (o.status != 'dead' OR o.delivery_kind != 'ordered' OR NOT EXISTS (
           SELECT 1 FROM outbox terminal WHERE terminal.target = o.target
             AND terminal.ordering_key = o.ordering_key
             AND terminal.delivery_generation = o.delivery_generation
             AND terminal.delivery_kind IN ('terminal', 'stop')
             AND terminal.status IN ('pending', 'sent') AND terminal.priority <= o.priority
         ))
         AND NOT (?8 > 0 AND ${PROGRESS_SQL("o")} AND EXISTS (
           SELECT 1 FROM outbox s WHERE s.target=o.target AND s.ordering_key=o.ordering_key
             AND s.delivery_generation=o.delivery_generation AND ${PROGRESS_SQL("s")}
             AND s.status='sent' AND s.sent_at>?4-?8
         ) AND NOT EXISTS (
           SELECT 1 FROM outbox n WHERE n.target=o.target AND n.ordering_key=o.ordering_key
             AND n.delivery_generation=o.delivery_generation AND n.id>o.id
             AND n.status='pending' AND n.priority<=5 AND NOT ${PROGRESS_SQL("n")}
         ))
     ), eligible AS (
       SELECT o.*
       FROM ranked r CROSS JOIN outbox o ON r.id=o.id
       WHERE r.position=1 AND o.status='pending' AND o.not_before<=?4
         AND (o.locked_until IS NULL OR o.locked_until<=?5)
         AND (o.target<>'linear' OR NOT EXISTS(
           SELECT 1 FROM linear_outbox_backoff WHERE not_before>?4
         ))
         AND NOT EXISTS (
           SELECT 1 FROM json_each(?3) WHERE value=o.target || ':' || o.ordering_key
         )
         AND NOT EXISTS (
           SELECT 1 FROM outbox busy WHERE busy.target=o.target
             AND busy.ordering_key=o.ordering_key AND busy.locked_until>?6
         )
     )
     UPDATE outbox SET locked_by = ?1, locked_until = ?2, attempts = attempts + 1
     WHERE id IN (
       SELECT o.id FROM eligible o
       ORDER BY o.priority, o.id LIMIT ?7
     ) RETURNING *`,
    )
    .all(
      workerId,
      now + leaseMs,
      JSON.stringify(options.blockedKeys ?? []),
      now,
      now,
      now,
      limit,
      options.progressIntervalMs ?? 0,
    );
  return rows.map(mapOutbox);
}

export function isOutboxCurrent(db: Database, row: OutboxRow): boolean {
  const current = getOutbox(db, row.id);
  if (
    !current ||
    current.status !== "pending" ||
    current.attempts !== row.attempts ||
    current.lockedBy !== row.lockedBy
  )
    return false;
  if (current.orderingKey === null) return true;
  const fence = getFence(db, current.target, current.orderingKey);
  return current.generation === fence.generation && (!fence.stopped || current.delivery === "stop");
}

export function advanceOutboxSession(
  db: Database,
  target: OutboxTarget,
  orderingKey: string,
  options: { stop?: boolean; now?: number } = {},
): number {
  return immediate(db, () => {
    const now = options.now ?? Date.now();
    const generation = getFence(db, target, orderingKey).generation + 1;
    db.run(
      `INSERT INTO outbox_session_fence (target, ordering_key, generation, stopped, updated_at)
      VALUES (?, ?, ?, ?, ?) ON CONFLICT (target, ordering_key) DO UPDATE SET
      generation = excluded.generation, stopped = excluded.stopped, updated_at = excluded.updated_at`,
      [target, orderingKey, generation, options.stop ? 1 : 0, now],
    );
    db.run(
      `UPDATE outbox SET status = 'dropped', error = ?
      WHERE target = ? AND ordering_key = ? AND status IN ('pending', 'dead')`,
      [
        options.stop
          ? "Fenced by Stop; payload retained for reconciliation."
          : "Superseded by an accepted newer session generation.",
        target,
        orderingKey,
      ],
    );
    return generation;
  });
}

export function stopOutboxSession(
  db: Database,
  target: OutboxTarget,
  orderingKey: string,
  now = Date.now(),
): number {
  return immediate(db, () => {
    const fence = getFence(db, target, orderingKey);
    return fence.stopped
      ? fence.generation
      : advanceOutboxSession(db, target, orderingKey, { stop: true, now });
  });
}

export function completeOutbox(db: Database, row: OutboxRow, now = Date.now()): boolean {
  return immediate(db, () => {
    const result = db
      .query<{ status: OutboxStatus }, [number, number, string | null, number]>(
        `UPDATE outbox SET status = CASE WHEN status = 'pending' THEN 'sent' ELSE status END,
       sent_at = ?, locked_by = NULL, locked_until = NULL,
       error = CASE WHEN status = 'dropped' THEN 'Superseded delivery completed; external effect may have occurred.' ELSE NULL END
     WHERE id = ? AND status IN ('pending', 'dropped') AND locked_by = ? AND attempts = ? RETURNING status`,
      )
      .get(now, row.id, row.lockedBy, row.attempts);
    if (result?.status !== "sent") return false;
    if (row.orderingKey !== null)
      db.run(
        `UPDATE outbox SET status = 'sent', sent_at = ?, error = ?
      WHERE target = ? AND ordering_key = ? AND status = 'dropped' AND error = ?`,
        [
          now,
          `Delivered with outbox ${row.id}.`,
          row.target,
          row.orderingKey,
          `Sending with outbox ${row.id}.`,
        ],
      );
    return true;
  });
}

export function releaseOutboxLease(db: Database, row: OutboxRow): void {
  db.run(
    `UPDATE outbox SET locked_by = NULL, locked_until = NULL
    WHERE id = ? AND status = 'dropped' AND locked_by = ? AND attempts = ?`,
    [row.id, row.lockedBy, row.attempts],
  );
}

export function retryOutbox(
  db: Database,
  row: OutboxRow,
  error: unknown,
  options: { now?: number; baseMs?: number; capMs?: number } = {},
): void {
  immediate(db, () => {
    const now = options.now ?? Date.now();
    const retryAfter =
      row.target === "linear" && error instanceof Error && error.name === "LinearRateLimitError"
        ? (error as Error & { retryAfterMs?: number }).retryAfterMs
        : undefined;
    const rateLimited =
      typeof retryAfter === "number" &&
      Number.isSafeInteger(retryAfter) &&
      retryAfter >= 0 &&
      Number.isSafeInteger(now + retryAfter);
    const delay = rateLimited
      ? retryAfter
      : retryBackoffMs(
          row.attempts,
          options.baseMs ?? DEFAULT_BACKOFF_BASE_MS,
          options.capMs ?? DEFAULT_BACKOFF_CAP_MS,
        );
    if (rateLimited) {
      db.run(
        `INSERT INTO linear_outbox_backoff(id,not_before) VALUES(1,?)
         ON CONFLICT(id) DO UPDATE SET not_before=MAX(not_before,excluded.not_before)`,
        [now + delay],
      );
    }
    db.run(
      `UPDATE outbox
       SET status = CASE WHEN ? THEN 'pending' WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
           max_attempts=max_attempts+?,
           not_before = CASE WHEN ? OR attempts < max_attempts THEN ? ELSE not_before END,
           locked_by = NULL,
           locked_until = NULL,
           error = ?
       WHERE id = ? AND status = 'pending' AND locked_by = ? AND attempts = ?`,
      [
        rateLimited ? 1 : 0,
        rateLimited ? 1 : 0,
        rateLimited ? 1 : 0,
        now + delay,
        errorText(error),
        row.id,
        row.lockedBy,
        row.attempts,
      ],
    );
    db.run(
      `UPDATE outbox SET locked_by = NULL, locked_until = NULL,
        error = COALESCE(error, '') || ' Superseded delivery failed or aborted; external effect may have occurred.'
      WHERE id = ? AND status = 'dropped' AND locked_by = ? AND attempts = ?`,
      [row.id, row.lockedBy, row.attempts],
    );
  });
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
    if (!isOutboxCurrent(db, row)) {
      releaseOutboxLease(db, row);
      continue;
    }
    try {
      deliver(row);
      completeOutbox(db, row, options.now);
    } catch (error) {
      retryOutbox(db, row, error, { now: options.now });
    }
  }
  return claimed;
}

export function coalesceOutbox(
  db: Database,
  row: OutboxRow,
  options: { now?: number; thoughts?: boolean } = {},
): OutboxRow {
  if (row.target !== "linear" || row.orderingKey === null) return row;
  const now = options.now ?? Date.now();
  const session = row.op.startsWith("linear.session.") && mergeableSession(row);
  if (!session && !(options.thoughts && row.attempts === 1 && mergeableThought(row))) return row;
  return immediate(db, () => {
    const others = db
      .query<OutboxSqlRow, [string, number, number, number]>(
        `SELECT * FROM outbox WHERE target = 'linear' AND ordering_key = ? AND delivery_generation = ?
          AND id <> ? AND status = 'pending' AND (locked_until IS NULL OR locked_until <= ?)
        ORDER BY id`,
      )
      .all(row.orderingKey!, row.generation ?? 0, row.id, now)
      .map(mapOutbox);
    const merged = session
      ? others.filter((other) => other.op.startsWith("linear.session.") && mergeableSession(other))
      : followingThoughts(row, others);
    if (merged.length === 0) return row;
    const payload = session
      ? mergeSessionPayloads([row, ...merged].sort((a, b) => a.id - b.id))
      : {
          ...(row.payload as object),
          body: [row, ...merged]
            .map((entry) => (entry.payload as { body: string }).body)
            .join("\n\n"),
        };
    const updated = db.run(
      `UPDATE outbox SET payload = ? WHERE id = ? AND status = 'pending' AND locked_by = ? AND attempts = ?`,
      [JSON.stringify(payload), row.id, row.lockedBy, row.attempts],
    );
    if (updated.changes !== 1) return row;
    const ids = JSON.stringify(merged.map((entry) => entry.id));
    db.run(
      `UPDATE outbox SET status = 'dropped', error = ? WHERE id IN (SELECT value FROM json_each(?))`,
      [session ? `Sending with outbox ${row.id}.` : `Merged into outbox ${row.id}.`, ids],
    );
    return { ...row, payload };
  });
}

export function attachSessionUpdates(db: Database, id: number, now = Date.now()): void {
  immediate(db, () => {
    const row = getOutbox(db, id);
    if (row === null || row.status !== "pending" || row.orderingKey === null) return;
    const sessions = db
      .query<OutboxSqlRow, [string, number, number, number]>(
        `SELECT * FROM outbox WHERE target = 'linear' AND ordering_key = ? AND delivery_generation = ?
          AND op LIKE 'linear.session.%' AND status = 'pending' AND not_before <= ?
          AND (locked_until IS NULL OR locked_until <= ?) ORDER BY id`,
      )
      .all(row.orderingKey, row.generation ?? 0, now, now)
      .map(mapOutbox)
      .filter(mergeableSession);
    if (sessions.length === 0) return;
    const updated = db.run(
      `UPDATE outbox SET payload = json_set(payload, '$.session', json(?)) WHERE id = ?
        AND status = 'pending' AND (locked_until IS NULL OR locked_until <= ?)`,
      [JSON.stringify(mergeSessionPayloads(sessions)), id, now],
    );
    if (updated.changes !== 1) return;
    db.run(
      `UPDATE outbox SET status = 'dropped', error = ? WHERE id IN (SELECT value FROM json_each(?))`,
      [`Sending with outbox ${id}.`, JSON.stringify(sessions.map((session) => session.id))],
    );
  });
}

const SESSION_FIELDS = new Set([
  "agentSteps",
  "hostPlan",
  "phase",
  "restartVersion",
  "waits",
  "sessionId",
  "plan",
  "summary",
  "addedExternalUrls",
  "identifier",
  "mode",
  "itemId",
]);

function mergeableSession(row: OutboxRow): boolean {
  return Object.keys(row.payload as object).every((field) => SESSION_FIELDS.has(field));
}

function mergeSessionPayloads(rows: readonly OutboxRow[]): Record<string, unknown> {
  const urls = new Map<string, unknown>();
  let payload: Record<string, unknown> = {};
  for (const row of rows) {
    const next = row.payload as Record<string, unknown> & { addedExternalUrls?: { url: string }[] };
    for (const entry of next.addedExternalUrls ?? [])
      if (!urls.has(entry.url)) urls.set(entry.url, entry);
    payload = { ...payload, ...next };
  }
  return urls.size === 0 ? payload : { ...payload, addedExternalUrls: [...urls.values()] };
}

function mergeableThought(row: OutboxRow): boolean {
  const payload = row.payload as Record<string, unknown>;
  return (
    row.delivery === "progress" &&
    (row.op === "activity" || row.op === "linear.activity") &&
    payload["kind"] === "thought" &&
    payload["ephemeral"] !== true &&
    payload["action"] === undefined &&
    typeof payload["body"] === "string"
  );
}

function followingThoughts(head: OutboxRow, others: readonly OutboxRow[]): OutboxRow[] {
  const merged: OutboxRow[] = [];
  for (const other of others) {
    if (other.id < head.id || other.priority > 5) continue;
    if (!mergeableThought(other) || (other.payload as { id?: unknown }).id !== undefined) break;
    merged.push(other);
  }
  return merged;
}

function insertOutbox(db: Database, row: NewOutbox, ignore = false): number | null {
  return immediate(db, () => {
    const now = row.now ?? Date.now();
    const delivery = row.delivery ?? deliveryKind(row);
    const fence = row.orderingKey
      ? getFence(db, row.target, row.orderingKey)
      : { generation: 0, stopped: false };
    const generation = row.generation ?? fence.generation;
    const terminal =
      row.orderingKey &&
      (delivery === "progress" ||
        (delivery === "critical" &&
          (row.op === "elicitation" ||
            ["thought", "action"].includes((row.payload as { kind?: string })?.kind ?? "")))) &&
      db
        .query<{ id: number }, [string, string, number]>(
          `SELECT id FROM outbox WHERE target = ? AND ordering_key = ? AND delivery_generation = ?
       AND delivery_kind IN ('terminal', 'stop') AND status != 'dropped' LIMIT 1`,
        )
        .get(row.target, row.orderingKey, generation);
    const blocked =
      generation !== fence.generation ||
      (fence.stopped && delivery !== "stop") ||
      Boolean(terminal);
    const progressActivity =
      Boolean(row.orderingKey) &&
      row.target === "linear" &&
      delivery === "progress" &&
      (row.op === "activity" || row.op === "linear.activity");
    const verb = ignore ? "INSERT OR IGNORE" : "INSERT";
    const inserted = db
      .query<{ id: number }, (string | number | null)[]>(
        `${verb} INTO outbox (target, op, ordering_key, idempotency_key, payload, priority,
        not_before, created_at, max_attempts, delivery_kind, delivery_generation, status, error, activity_run_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         (SELECT current_run_id FROM work_item WHERE id=?)) RETURNING id`,
      )
      .get(
        row.target,
        row.op,
        row.orderingKey ?? null,
        row.idempotencyKey,
        JSON.stringify(row.payload ?? {}),
        row.priority ?? deliveryPriority(delivery),
        row.notBefore ?? 0,
        now,
        row.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS,
        delivery,
        generation,
        blocked ? "dropped" : "pending",
        blocked ? "Rejected by the persisted session fence." : null,
        (row.payload as { itemId?: string } | undefined)?.itemId ?? null,
      );
    if (inserted && !blocked && row.orderingKey && !row.op.startsWith("linear.session."))
      db.run(
        `UPDATE outbox SET not_before = 0 WHERE target = ? AND ordering_key = ? AND id <> ?
          AND status = 'pending' AND attempts = 0 AND delivery_kind = 'critical'
          AND op IN ('activity', 'linear.activity') AND not_before > ?`,
        [row.target, row.orderingKey, inserted.id, now],
      );
    if (inserted && !blocked && row.target === "linear" && delivery === "progress") {
      db.run(
        `UPDATE outbox SET status='dropped',error='Superseded by a newer canonical run.'
         WHERE target='linear' AND ordering_key=? AND status='pending' AND locked_by IS NULL
           AND delivery_kind='progress' AND op IN ('activity','linear.activity')
           AND COALESCE(json_extract(payload,'$.ephemeral'),0)=1
           AND activity_run_id IS NOT NULL AND activity_run_id<>(
             SELECT activity_run_id FROM outbox WHERE id=?
           )`,
        [row.orderingKey ?? null, inserted.id],
      );
    }
    if (inserted && !blocked && progressActivity) {
      db.run(
        `UPDATE outbox SET status = 'dropped', error = 'Superseded by newer progress.'
        WHERE target = ? AND ordering_key = ? AND delivery_generation = ? AND id < ?
          AND status = 'pending' AND attempts = 0 AND locked_by IS NULL
          AND delivery_kind = 'progress' AND op IN ('activity', 'linear.activity')
          AND json_extract(payload, '$.ephemeral') = 1
          AND json_extract(payload, '$.kind') IN ('thought', 'action')`,
        [row.target, row.orderingKey!, generation, inserted.id],
      );
    }
    if (
      !inserted ||
      blocked ||
      !row.orderingKey ||
      !["critical", "terminal", "stop"].includes(delivery)
    )
      return inserted?.id ?? null;
    db.run(
      `UPDATE outbox SET status = 'dropped', error = 'Superseded by a critical session update.'
      WHERE target = ? AND ordering_key = ? AND id < ? AND status IN ('pending', 'dead')
        AND ((delivery_kind = 'progress' AND (op NOT IN ('activity','linear.activity')
          OR COALESCE(json_extract(payload,'$.ephemeral'),0)=1
          OR COALESCE(json_extract(payload,'$.kind'),'') NOT IN ('thought','action')))
          OR (? = 'terminal' AND delivery_kind = 'critical'
          AND (op='elicitation' OR json_extract(payload,'$.kind') IN ('thought','action'))))`,
      [row.target, row.orderingKey, inserted.id, delivery],
    );
    return inserted.id;
  });
}

function deliveryKind(row: NewOutbox): OutboxDelivery {
  if (row.target !== "linear") return "ordered";
  const payload = row.payload as { kind?: string; stateType?: string } | undefined;
  if (row.op === "elicitation") return "critical";
  if (row.op === "status") return payload?.stateType === "completed" ? "status" : "progress";
  if (row.op === "activity" || row.op === "linear.activity") {
    return payload?.kind === "response" || payload?.kind === "error" ? "terminal" : "progress";
  }
  return "ordered";
}

function deliveryPriority(kind: OutboxDelivery): number {
  return kind === "stop"
    ? -1
    : kind === "terminal"
      ? 0
      : kind === "critical"
        ? 1
        : kind === "status"
          ? 3
          : 5;
}

function getFence(
  db: Database,
  target: OutboxTarget,
  orderingKey: string,
): { generation: number; stopped: boolean } {
  const row = db
    .query<{ generation: number; stopped: number }, [string, string]>(
      "SELECT generation, stopped FROM outbox_session_fence WHERE target = ? AND ordering_key = ?",
    )
    .get(target, orderingKey);
  return { generation: row?.generation ?? 0, stopped: row?.stopped === 1 };
}

function mapOutbox(row: OutboxSqlRow): OutboxRow {
  return {
    delivery: row.delivery_kind,
    generation: row.delivery_generation,
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
