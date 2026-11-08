import { journalCaught, journalItemId } from "../journal";
import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, gt, ilike, inArray, like, lt, ne, or, sql } from "drizzle-orm";
import {
  DEFAULT_BACKOFF_BASE_MS,
  DEFAULT_BACKOFF_CAP_MS,
  DEFAULT_LEASE_MS,
  JOB_KIND,
  retryBackoffMs,
} from "../core";
import { settled, sqliteDb, type Db, type Q } from "./db";
import { jsonField } from "./json-text";
import { enqueueJobOnce, errorText } from "./jobs";
import { journal } from "./journal";
import type * as pgSchema from "./schema-pg";
import { immediate } from "./tx";

const OUTBOX_TARGETS = ["linear", "slack", "github"] as const;
export type OutboxTarget = (typeof OUTBOX_TARGETS)[number];

const OUTBOX_STATUSES = ["pending", "sent", "dead", "dropped"] as const;
export type OutboxStatus = (typeof OUTBOX_STATUSES)[number];

export const DEFAULT_OUTBOX_MAX_ATTEMPTS = 5;
export const LINEAR_PROGRESS_INTERVAL_MS = 30_000;

type Dialect = Q["dialect"];

/** A field of a JSON payload as text: `json_extract` on SQLite, `->>` on Postgres. */
function jsonText(dialect: Dialect, payload: string, key: string): string {
  return dialect === "sqlite" ? `json_extract(${payload}, '$.${key}')` : `(${payload}->>'${key}')`;
}

/** A field of a JSON payload is `true` or `1`. */
function jsonOne(dialect: Dialect, payload: string, key: string): string {
  return dialect === "sqlite"
    ? `COALESCE(json_extract(${payload}, '$.${key}'), 0) = 1`
    : `COALESCE((${payload}->'${key}') IN ('true'::jsonb, '1'::jsonb), false)`;
}

const PROGRESS_SQL = (dialect: Dialect, row: string) =>
  `(${row}.target='linear' AND ${row}.delivery_kind='progress'
    AND ${row}.op = 'activity'
    AND COALESCE(${jsonText(dialect, `${row}.payload`, "kind")},'') IN ('thought','action'))`;

/** SQLite's LIKE ignores ASCII case; Postgres needs ILIKE for the same match. */
function likeOf(q: Q) {
  return q.dialect === "sqlite" ? like : ilike;
}

/** SQLite stores a payload as JSON text, Postgres as `jsonb`. */
function payloadIn(q: Q, payload: unknown): unknown {
  return q.dialect === "sqlite" ? JSON.stringify(payload) : payload;
}

function payloadOut(q: Q, stored: unknown): unknown {
  return q.dialect === "sqlite" ? (JSON.parse(stored as string) as unknown) : stored;
}

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

type OutboxClaimOptions = {
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
  return settled(sqliteDb(db).transaction((q) => enqueueOutboxSteps(q, row)));
}

export function* enqueueOutboxSteps(q: Q, row: NewOutbox) {
  const inserted = yield* insertOutboxSteps(q, row);
  if (inserted === null) {
    throw new Error("enqueueOutbox did not return an id");
  }
  return inserted;
}

/** Store the row once. A repeat of the same idempotency key returns the original id. */
export function enqueueOutboxOnce(db: Database, row: NewOutbox): number {
  return settled(sqliteDb(db).transaction((q) => enqueueOutboxOnceSteps(q, row)));
}

export function* enqueueOutboxOnceSteps(q: Q, row: NewOutbox) {
  const inserted = yield* insertOutboxSteps(q, row, true);
  if (inserted !== null) return inserted;
  const { outbox } = q.t;
  const existing = yield* q.one(
    q.orm
      .select({ id: outbox.id })
      .from(outbox)
      .where(eq(outbox.idempotencyKey, row.idempotencyKey)),
  );
  if (existing === undefined) {
    throw new Error("enqueueOutboxOnce did not store a row");
  }
  return existing.id;
}

/**
 * The highest number that follows `prefix` in a stored idempotency key, or 0. A counter that
 * starts from it after a restart does not reuse a key from before the restart.
 */
export function lastOutboxSequence(db: Database, prefix: string): number {
  return settled(sqliteDb(db).run((q) => lastOutboxSequenceSteps(q, prefix)));
}

export function* lastOutboxSequenceSteps(q: Q, prefix: string) {
  const { outbox } = q.t;
  // Byte order on both: Postgres compares text by the database collation unless told otherwise.
  const key = sql`${outbox.idempotencyKey}${sql.raw(q.dialect === "sqlite" ? "" : ' COLLATE "C"')}`;
  const rows = yield* q.all(
    q.orm
      .select({ key: outbox.idempotencyKey })
      .from(outbox)
      .where(sql`${key} > ${prefix} AND ${key} < ${`${prefix}\u{10ffff}`}`),
  );
  return rows.reduce((last, row) => {
    const suffix = row.key.slice(prefix.length);
    return /^\d+$/.test(suffix) ? Math.max(last, Number(suffix)) : last;
  }, 0);
}

export function getOutbox(db: Database, id: number): OutboxRow | null {
  return settled(sqliteDb(db).run((q) => getOutboxSteps(q, id)));
}

export function* getOutboxSteps(q: Q, id: number) {
  const { outbox } = q.t;
  const row = yield* q.one(q.orm.select().from(outbox).where(eq(outbox.id, id)));
  return row === undefined ? null : mapOutbox(q, row);
}

export function listOutbox(db: Database, orderingKey?: string): OutboxRow[] {
  return settled(sqliteDb(db).run((q) => listOutboxSteps(q, orderingKey)));
}

export function* listOutboxSteps(q: Q, orderingKey?: string) {
  const { outbox } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(outbox)
      .where(orderingKey === undefined ? undefined : eq(outbox.orderingKey, orderingKey))
      .orderBy(asc(outbox.id)),
  );
  return rows.map((row) => mapOutbox(q, row));
}

/**
 * Claim the ready head of each ordering key. A dead or in-flight head blocks
 * only that key. Rows with a null ordering key are independent.
 * Status stays `pending` while the lease is held; 001 has no inflight status.
 */
export function claimOutboxHeads(db: Database, options: OutboxClaimOptions = {}): OutboxRow[] {
  return settled(sqliteDb(db).run((q) => claimOutboxHeadsSteps(q, options)));
}

export function* claimOutboxHeadsSteps(q: Q, options: OutboxClaimOptions) {
  const now = options.now ?? Date.now();
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const workerId = options.workerId ?? "outbox";
  const limit = options.limit ?? 32;
  const intervalMs = options.progressIntervalMs ?? 0;
  const blockedKeys = options.blockedKeys ?? [];
  const progress = (row: string) => sql.raw(PROGRESS_SQL(q.dialect, row));
  const throttled =
    intervalMs > 0
      ? sql`AND NOT (${progress("o")} AND EXISTS (
           SELECT 1 FROM outbox s WHERE s.target=o.target AND s.ordering_key=o.ordering_key
             AND s.delivery_generation=o.delivery_generation AND ${progress("s")}
             AND s.status='sent' AND s.sent_at>${now - intervalMs}
         ) AND NOT EXISTS (
           SELECT 1 FROM outbox n WHERE n.target=o.target AND n.ordering_key=o.ordering_key
             AND n.delivery_generation=o.delivery_generation AND n.id>o.id
             AND n.status='pending' AND n.priority<=5 AND NOT ${progress("n")}
         ))`
      : sql``;
  const blocked =
    blockedKeys.length > 0
      ? sql`AND NOT (o.ordering_key IS NOT NULL AND o.target || ':' || o.ordering_key IN (${sql.join(
          blockedKeys.map((key) => sql`${key}`),
          sql`, `,
        )}))`
      : sql``;
  // SQLite's CROSS JOIN keeps the planner's join order; Postgres has no CROSS JOIN … ON.
  const join = sql.raw(q.dialect === "sqlite" ? "CROSS JOIN" : "JOIN");
  const heads = sql`WITH ranked AS (
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
         ${throttled}
     ), eligible AS (
       SELECT o.*
       FROM ranked r ${join} outbox o ON r.id=o.id
       WHERE r.position=1 AND o.status='pending' AND o.not_before<=${now}
         AND (o.locked_until IS NULL OR o.locked_until<=${now})
         AND (o.target<>'linear' OR NOT EXISTS(
           SELECT 1 FROM linear_outbox_backoff WHERE not_before>${now}
         ))
         ${blocked}
         AND NOT EXISTS (
           SELECT 1 FROM outbox busy WHERE busy.target=o.target
             AND busy.ordering_key=o.ordering_key AND busy.locked_until>${now}
         )
     )
     SELECT o.id FROM eligible o ORDER BY o.priority, o.id LIMIT ${limit}`;
  const { outbox } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(outbox)
      .set({
        lockedBy: workerId,
        lockedUntil: now + leaseMs,
        attempts: sql`${outbox.attempts} + 1`,
      })
      .where(sql`${outbox.id} IN (${heads})`)
      .returning(),
  );
  return rows.map((row) => mapOutbox(q, row));
}

export function isOutboxCurrent(db: Database, row: OutboxRow): boolean {
  return settled(sqliteDb(db).run((q) => isOutboxCurrentSteps(q, row)));
}

export function* isOutboxCurrentSteps(q: Q, row: OutboxRow) {
  const current = yield* getOutboxSteps(q, row.id);
  if (
    !current ||
    current.status !== "pending" ||
    current.attempts !== row.attempts ||
    current.lockedBy !== row.lockedBy
  )
    return false;
  if (current.orderingKey === null) return true;
  const fence = yield* getFenceSteps(q, current.target, current.orderingKey);
  return current.generation === fence.generation && (!fence.stopped || current.delivery === "stop");
}

export function advanceOutboxSession(
  db: Database,
  target: OutboxTarget,
  orderingKey: string,
  options: { stop?: boolean; now?: number } = {},
): number {
  return settled(
    sqliteDb(db).transaction((q) => advanceOutboxSessionSteps(q, target, orderingKey, options)),
  );
}

export function* advanceOutboxSessionSteps(
  q: Q,
  target: OutboxTarget,
  orderingKey: string,
  options: { stop?: boolean; now?: number },
) {
  const { outbox, outboxSessionFence: fence } = q.t;
  const now = options.now ?? Date.now();
  const generation = (yield* getFenceSteps(q, target, orderingKey)).generation + 1;
  const stopped = options.stop ? 1 : 0;
  yield* q.exec(
    q.orm
      .insert(fence)
      .values({ target, orderingKey, generation, stopped, updatedAt: now })
      .onConflictDoUpdate({
        target: [fence.target, fence.orderingKey],
        set: { generation, stopped, updatedAt: now },
      }),
  );
  yield* q.exec(
    q.orm
      .update(outbox)
      .set({
        status: "dropped",
        error: options.stop
          ? "Fenced by Stop; payload retained for reconciliation."
          : "Superseded by an accepted newer session generation.",
      })
      .where(
        and(
          eq(outbox.target, target),
          eq(outbox.orderingKey, orderingKey),
          inArray(outbox.status, ["pending", "dead"]),
        ),
      ),
  );
  return generation;
}

export function stopOutboxSession(
  db: Database,
  target: OutboxTarget,
  orderingKey: string,
  now = Date.now(),
): number {
  return settled(
    sqliteDb(db).transaction((q) => stopOutboxSessionSteps(q, target, orderingKey, now)),
  );
}

export function* stopOutboxSessionSteps(
  q: Q,
  target: OutboxTarget,
  orderingKey: string,
  now: number,
) {
  const fence = yield* getFenceSteps(q, target, orderingKey);
  return fence.stopped
    ? fence.generation
    : yield* advanceOutboxSessionSteps(q, target, orderingKey, { stop: true, now });
}

/** `locked_by = ?` as the raw SQL wrote it: a null lease holder matches no row. */
function heldBy(q: Q, lockedBy: string | null) {
  return sql`${q.t.outbox.lockedBy} = ${lockedBy}`;
}

export function completeOutbox(db: Database, row: OutboxRow, now = Date.now()): boolean {
  return settled(sqliteDb(db).transaction((q) => completeOutboxSteps(q, row, now)));
}

export function* completeOutboxSteps(q: Q, row: OutboxRow, now: number) {
  const { outbox } = q.t;
  const result = yield* q.one(
    q.orm
      .update(outbox)
      .set({
        status: sql`CASE WHEN ${outbox.status} = 'pending' THEN 'sent' ELSE ${outbox.status} END`,
        sentAt: now,
        lockedBy: null,
        lockedUntil: null,
        error: sql`CASE WHEN ${outbox.status} = 'dropped' THEN 'Superseded delivery completed; external effect may have occurred.' ELSE NULL END`,
      })
      .where(
        and(
          eq(outbox.id, row.id),
          inArray(outbox.status, ["pending", "dropped"]),
          heldBy(q, row.lockedBy),
          eq(outbox.attempts, row.attempts),
        ),
      )
      .returning({ status: outbox.status }),
  );
  if (result?.status !== "sent") return false;
  if (row.orderingKey !== null)
    yield* q.exec(
      q.orm
        .update(outbox)
        .set({ status: "sent", sentAt: now, error: `Delivered with outbox ${row.id}.` })
        .where(
          and(
            eq(outbox.target, row.target),
            eq(outbox.orderingKey, row.orderingKey),
            eq(outbox.status, "dropped"),
            eq(outbox.error, `Sending with outbox ${row.id}.`),
          ),
        ),
    );
  return true;
}

export function releaseOutboxLease(db: Database, row: OutboxRow): void {
  settled(sqliteDb(db).run((q) => releaseOutboxLeaseSteps(q, row)));
}

export function* releaseOutboxLeaseSteps(q: Q, row: OutboxRow) {
  const { outbox } = q.t;
  yield* q.exec(
    q.orm
      .update(outbox)
      .set({ lockedBy: null, lockedUntil: null })
      .where(
        and(
          eq(outbox.id, row.id),
          eq(outbox.status, "dropped"),
          heldBy(q, row.lockedBy),
          eq(outbox.attempts, row.attempts),
        ),
      ),
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
    const updated = db
      .query<{ status: OutboxStatus }, (string | number | null)[]>(
        `UPDATE outbox
       SET status = CASE WHEN ? THEN 'pending' WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
           max_attempts=max_attempts+?,
           not_before = CASE WHEN ? OR attempts < max_attempts THEN ? ELSE not_before END,
           locked_by = NULL,
           locked_until = NULL,
           error = ?
       WHERE id = ? AND status = 'pending' AND locked_by = ? AND attempts = ? RETURNING status`,
      )
      .get(
        rateLimited ? 1 : 0,
        rateLimited ? 1 : 0,
        rateLimited ? 1 : 0,
        now + delay,
        errorText(error),
        row.id,
        row.lockedBy,
        row.attempts,
      );
    if (updated?.status === "dead") settleDeadOutbox(db, row, errorText(error), now);
    db.run(
      `UPDATE outbox SET locked_by = NULL, locked_until = NULL,
        error = COALESCE(error, '') || ' Superseded delivery failed or aborted; external effect may have occurred.'
      WHERE id = ? AND status = 'dropped' AND locked_by = ? AND attempts = ?`,
      [row.id, row.lockedBy, row.attempts],
    );
  });
}

type DispatchOptions = OutboxClaimOptions & {
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
      journalCaught(error, "outbox.dispatchOutbox.deliver", journalItemId(row.payload));
      retryOutbox(db, row, error, { now: options.now });
    }
  }
  return claimed;
}

/** Whether a claimed row may absorb its session's later rows: session updates, or thoughts. */
function coalescing(row: OutboxRow, options: { thoughts?: boolean }): { session: boolean } | null {
  if (row.target !== "linear" || row.orderingKey === null) return null;
  const session = row.op.startsWith("linear.session.") && mergeableSession(row);
  if (!session && !(options.thoughts && row.attempts === 1 && mergeableThought(row))) return null;
  return { session };
}

export function coalesceOutbox(
  db: Database,
  row: OutboxRow,
  options: { now?: number; thoughts?: boolean } = {},
): OutboxRow {
  if (coalescing(row, options) === null) return row;
  return settled(sqliteDb(db).transaction((q) => coalesceOutboxSteps(q, row, options)));
}

/** `coalesceOutbox` for async callers: no transaction when nothing coalesces. */
export async function coalesceOutboxAsync(
  store: Db,
  row: OutboxRow,
  options: { now?: number; thoughts?: boolean } = {},
): Promise<OutboxRow> {
  if (coalescing(row, options) === null) return row;
  return store.transaction((q) => coalesceOutboxSteps(q, row, options));
}

export function* coalesceOutboxSteps(
  q: Q,
  row: OutboxRow,
  options: { now?: number; thoughts?: boolean } = {},
) {
  const plan = coalescing(row, options);
  if (plan === null || row.orderingKey === null) return row;
  const { session } = plan;
  const now = options.now ?? Date.now();
  const orderingKey = row.orderingKey;
  const { outbox } = q.t;
  const others = (yield* q.all(
    q.orm
      .select()
      .from(outbox)
      .where(
        and(
          eq(outbox.target, "linear"),
          eq(outbox.orderingKey, orderingKey),
          eq(outbox.deliveryGeneration, row.generation ?? 0),
          ne(outbox.id, row.id),
          eq(outbox.status, "pending"),
          unlockedAt(q, now),
        ),
      )
      .orderBy(asc(outbox.id)),
  )).map((other) => mapOutbox(q, other));
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
  const updated = yield* q.all(
    q.orm
      .update(outbox)
      .set({ payload: payloadIn(q, payload) })
      .where(
        and(
          eq(outbox.id, row.id),
          eq(outbox.status, "pending"),
          heldBy(q, row.lockedBy),
          eq(outbox.attempts, row.attempts),
        ),
      )
      .returning({ id: outbox.id }),
  );
  if (updated.length !== 1) return row;
  yield* q.exec(
    q.orm
      .update(outbox)
      .set({
        status: "dropped",
        error: session ? `Sending with outbox ${row.id}.` : `Merged into outbox ${row.id}.`,
      })
      .where(
        inArray(
          outbox.id,
          merged.map((entry) => entry.id),
        ),
      ),
  );
  return { ...row, payload };
}

function unlockedAt(q: Q, now: number) {
  const { outbox } = q.t;
  return sql`(${outbox.lockedUntil} IS NULL OR ${outbox.lockedUntil} <= ${now})`;
}

export function attachSessionUpdates(db: Database, id: number, now = Date.now()): void {
  settled(sqliteDb(db).transaction((q) => attachSessionUpdatesSteps(q, id, now)));
}

export function* attachSessionUpdatesSteps(q: Q, id: number, now: number) {
  const { outbox } = q.t;
  const row = yield* getOutboxSteps(q, id);
  if (row === null || row.status !== "pending" || row.orderingKey === null) return;
  const sessions = (yield* q.all(
    q.orm
      .select()
      .from(outbox)
      .where(
        and(
          eq(outbox.target, "linear"),
          eq(outbox.orderingKey, row.orderingKey),
          eq(outbox.deliveryGeneration, row.generation ?? 0),
          likeOf(q)(outbox.op, "linear.session.%"),
          eq(outbox.status, "pending"),
          sql`${outbox.notBefore} <= ${now}`,
          unlockedAt(q, now),
        ),
      )
      .orderBy(asc(outbox.id)),
  ))
    .map((session) => mapOutbox(q, session))
    .filter(mergeableSession);
  if (sessions.length === 0) return;
  const merged = JSON.stringify(mergeSessionPayloads(sessions));
  const updated = yield* q.all(
    q.orm
      .update(outbox)
      .set({
        payload:
          q.dialect === "sqlite"
            ? sql`json_set(${outbox.payload}, '$.session', json(${merged}))`
            : sql`jsonb_set(${outbox.payload}, '{session}', ${merged}::jsonb)`,
      })
      .where(and(eq(outbox.id, id), eq(outbox.status, "pending"), unlockedAt(q, now)))
      .returning({ id: outbox.id }),
  );
  if (updated.length !== 1) return;
  yield* q.exec(
    q.orm
      .update(outbox)
      .set({ status: "dropped", error: `Sending with outbox ${id}.` })
      .where(
        inArray(
          outbox.id,
          sessions.map((session) => session.id),
        ),
      ),
  );
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
    row.op === "activity" &&
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

/** Suffix of the one fresh delivery a dead elicitation gets. */
const ELICITATION_REDELIVERY_SUFFIX = ":redelivery";
/** Suffix of the delivery that replaces a twice-dead elicitation of a question with linked records. */
export const ELICITATION_REASK_SUFFIX = ":reask";

/**
 * The work item an outbox row belongs to: the payload's item, the run that wrote it,
 * the question it asks, or the item whose session it is ordered on.
 */
export const OUTBOX_ITEM_SQL = (row: string, dialect: Dialect = "sqlite") => `COALESCE(
  (SELECT i.id FROM work_item i WHERE i.id = ${jsonText(dialect, `${row}.payload`, "itemId")}),
  (SELECT r.item_id FROM run r WHERE r.id = ${row}.activity_run_id),
  (SELECT q.item_id FROM question q WHERE q.id = ${jsonText(dialect, `${row}.payload`, "questionId")}),
  (SELECT i.id FROM work_item i WHERE ${row}.ordering_key IS NOT NULL
    AND i.session_key = ${row}.ordering_key ORDER BY i.created_at DESC, i.id DESC LIMIT 1)
)`;

function outboxItemId(db: Database, id: number): string | null {
  return settled(sqliteDb(db).run((q) => outboxItemIdSteps(q, id)));
}

export function* outboxItemIdSteps(q: Q, id: number) {
  const { outbox } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ itemId: sql<string | null>`${sql.raw(OUTBOX_ITEM_SQL("outbox", q.dialect))}` })
      .from(outbox)
      .where(eq(outbox.id, id)),
  );
  return row?.itemId ?? null;
}

export function oneLine(text: string, max = 200): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * A row just went dead. Journal it, and give an elicitation whose item still waits for
 * an answer one fresh delivery, so the person has something to answer. The dead row is
 * dropped in its favour; otherwise it would block the session's ordering key.
 * When the redelivery dies too, a job asks the question again, once per question lineage.
 * Anything still dead is listed on the issue page with a retry.
 */
function settleDeadOutbox(db: Database, row: OutboxRow, error: string, now: number): void {
  const itemId = outboxItemId(db, row.id);
  journal(
    `outbox ${row.id} ${row.target}.${row.op} dead item=${itemId ?? "-"} attempts=${row.attempts}/${row.maxAttempts} error=${oneLine(error)}`,
  );
  if (row.op !== "elicitation" || itemId === null) return;
  const item = db
    .query<{ state: string; runId: string | null }, [string]>(
      "SELECT state, current_run_id AS runId FROM work_item WHERE id = ?",
    )
    .get(itemId);
  if (item?.state !== "awaiting_input") return;
  const stored = getOutbox(db, row.id);
  const questionId = (stored?.payload as { questionId?: unknown } | undefined)?.questionId;
  const open =
    typeof questionId === "string" &&
    db
      .query<{ open: number }, [string]>(
        "SELECT status = 'open' AND cancelled_at IS NULL AS open FROM question WHERE id = ?",
      )
      .get(questionId)?.open === 1;
  if (typeof questionId === "string" && !open) return;
  const lastChance =
    row.idempotencyKey.endsWith(ELICITATION_REDELIVERY_SUFFIX) ||
    row.idempotencyKey.endsWith(ELICITATION_REASK_SUFFIX);
  if (lastChance) {
    const stays = () =>
      journal(
        `outbox ${row.id} elicitation dead again item=${itemId}; retry it from the issue page`,
      );
    if (!open) return stays();
    // One re-ask per question lineage: a question a re-ask produced counts as its origin.
    const origin =
      db
        .query<{ origin: string | null }, [string, string]>(
          `SELECT json_extract(payload, '$.questionId') AS origin FROM job
           WHERE queue = ? AND json_extract(payload, '$.reaskedAs') = ? LIMIT 1`,
        )
        .get(JOB_KIND.reaskQuestion, questionId)?.origin ?? questionId;
    const key = `${JOB_KIND.reaskQuestion}:${origin}`;
    if (db.query<{ id: number }, [string]>("SELECT id FROM job WHERE job_key = ?").get(key))
      return stays();
    enqueueJobOnce(db, {
      queue: JOB_KIND.reaskQuestion,
      jobKey: key,
      payload: { itemId, questionId },
      now,
    });
    journal(
      `outbox ${row.id} elicitation dead again item=${itemId}; re-asking question ${questionId}`,
    );
    return;
  }
  const id = insertOutbox(
    db,
    {
      target: row.target,
      op: row.op,
      ...(row.orderingKey === null ? {} : { orderingKey: row.orderingKey }),
      idempotencyKey: `${row.idempotencyKey}${ELICITATION_REDELIVERY_SUFFIX}`,
      payload: stored?.payload ?? row.payload,
      priority: row.priority,
      ...(row.delivery === undefined ? {} : { delivery: row.delivery }),
      ...(row.generation === undefined ? {} : { generation: row.generation }),
      now,
    },
    true,
  );
  if (id === null || getOutbox(db, id)?.status !== "pending") return;
  db.run(`UPDATE outbox SET status = 'dropped', error = ? WHERE id = ? AND status = 'dead'`, [
    `Dead: ${oneLine(error)} Re-enqueued as outbox ${id}.`,
    row.id,
  ]);
  journal(`outbox ${row.id} elicitation re-enqueued as outbox ${id} item=${itemId}`);
}

function insertOutbox(db: Database, row: NewOutbox, ignore = false): number | null {
  return settled(sqliteDb(db).transaction((q) => insertOutboxSteps(q, row, ignore)));
}

function* insertOutboxSteps(q: Q, row: NewOutbox, ignore = false) {
  const { outbox, workItem } = q.t;
  const now = row.now ?? Date.now();
  const delivery = row.delivery ?? deliveryKind(row);
  const fence = row.orderingKey
    ? yield* getFenceSteps(q, row.target, row.orderingKey)
    : { generation: 0, stopped: false };
  const generation = row.generation ?? fence.generation;
  const terminal =
    row.orderingKey &&
    (delivery === "progress" ||
      (delivery === "critical" &&
        (row.op === "elicitation" ||
          ["thought", "action"].includes((row.payload as { kind?: string })?.kind ?? "")))) &&
    (yield* q.one(
      q.orm
        .select({ id: outbox.id })
        .from(outbox)
        .where(
          and(
            eq(outbox.target, row.target),
            eq(outbox.orderingKey, row.orderingKey),
            eq(outbox.deliveryGeneration, generation),
            inArray(outbox.deliveryKind, ["terminal", "stop"]),
            ne(outbox.status, "dropped"),
          ),
        )
        .limit(1),
    ));
  const blocked =
    generation !== fence.generation || (fence.stopped && delivery !== "stop") || Boolean(terminal);
  const repeated =
    blocked ||
    (yield* q.one(
      q.orm
        .select({ one: sql`1` })
        .from(outbox)
        .where(eq(outbox.idempotencyKey, row.idempotencyKey)),
    ))
      ? null
      : yield* repeatedThoughtSteps(q, row, generation);
  if (repeated !== null) return repeated;
  const progressActivity =
    Boolean(row.orderingKey) &&
    row.target === "linear" &&
    delivery === "progress" &&
    row.op === "activity";
  const itemId = (row.payload as { itemId?: string } | undefined)?.itemId ?? null;
  const insert = q.orm.insert(outbox).values({
    target: row.target,
    op: row.op,
    orderingKey: row.orderingKey ?? null,
    idempotencyKey: row.idempotencyKey,
    payload: payloadIn(q, row.payload ?? {}),
    priority: row.priority ?? deliveryPriority(delivery),
    notBefore: row.notBefore ?? 0,
    createdAt: now,
    maxAttempts: row.maxAttempts ?? DEFAULT_OUTBOX_MAX_ATTEMPTS,
    deliveryKind: delivery,
    deliveryGeneration: generation,
    status: blocked ? "dropped" : "pending",
    error: blocked ? "Rejected by the persisted session fence." : null,
    activityRunId: sql`(SELECT ${workItem.currentRunId} FROM ${workItem} WHERE ${workItem.id} = ${itemId})`,
  });
  const inserted = yield* q.one(
    ignore
      ? insert.onConflictDoNothing().returning({ id: outbox.id })
      : insert.returning({ id: outbox.id }),
  );
  if (inserted && !blocked && row.orderingKey && !row.op.startsWith("linear.session."))
    yield* q.exec(
      q.orm
        .update(outbox)
        .set({ notBefore: 0 })
        .where(
          and(
            eq(outbox.target, row.target),
            eq(outbox.orderingKey, row.orderingKey),
            ne(outbox.id, inserted.id),
            eq(outbox.status, "pending"),
            eq(outbox.attempts, 0),
            eq(outbox.deliveryKind, "critical"),
            eq(outbox.op, "activity"),
            gt(outbox.notBefore, now),
          ),
        ),
    );
  const ephemeral = sql.raw(jsonOne(q.dialect, "payload", "ephemeral"));
  const kind = sql.raw(jsonText(q.dialect, "payload", "kind"));
  if (inserted && !blocked && row.target === "linear" && delivery === "progress") {
    yield* q.exec(
      q.orm
        .update(outbox)
        .set({ status: "dropped", error: "Superseded by a newer canonical run." })
        .where(
          sql`target='linear' AND ordering_key=${row.orderingKey ?? null} AND status='pending'
            AND locked_by IS NULL AND delivery_kind='progress' AND op = 'activity'
            AND ${ephemeral}
            AND activity_run_id IS NOT NULL AND activity_run_id<>(
              SELECT activity_run_id FROM outbox WHERE id=${inserted.id}
            )`,
        ),
    );
  }
  if (inserted && !blocked && progressActivity) {
    yield* q.exec(
      q.orm
        .update(outbox)
        .set({ status: "dropped", error: "Superseded by newer progress." })
        .where(
          sql`target = ${row.target} AND ordering_key = ${row.orderingKey!}
            AND delivery_generation = ${generation} AND id < ${inserted.id}
            AND status = 'pending' AND attempts = 0 AND locked_by IS NULL
            AND delivery_kind = 'progress' AND op = 'activity'
            AND ${ephemeral} AND ${kind} IN ('thought', 'action')`,
        ),
    );
  }
  if (
    !inserted ||
    blocked ||
    !row.orderingKey ||
    !["critical", "terminal", "stop"].includes(delivery)
  )
    return inserted?.id ?? null;
  const supersedesCritical =
    delivery === "terminal"
      ? sql`OR (delivery_kind = 'critical'
          AND ((op='elicitation' AND COALESCE((SELECT state FROM work_item
                WHERE id = ${sql.raw(OUTBOX_ITEM_SQL("outbox", q.dialect))}), '') <> 'awaiting_input')
            OR ${kind} IN ('thought','action')))`
      : sql``;
  yield* q.exec(
    q.orm
      .update(outbox)
      .set({ status: "dropped", error: "Superseded by a critical session update." })
      .where(
        sql`target = ${row.target} AND ordering_key = ${row.orderingKey} AND id < ${inserted.id}
          AND status IN ('pending', 'dead')
          AND ((delivery_kind = 'progress' AND (op <> 'activity'
            OR ${ephemeral}
            OR COALESCE(${kind},'') NOT IN ('thought','action')))
            ${supersedesCritical})`,
      ),
  );
  return inserted.id;
}

/**
 * A Linear thought whose body equals the session's last sent or pending thought in the same
 * phase is not stored again; the id of that earlier thought is returned instead. A response,
 * an error or a question starts a new phase. An ephemeral line may repeat an ephemeral line:
 * Linear replaces the one it shows, and a pending one is superseded by the newer.
 */
function* repeatedThoughtSteps(q: Q, row: NewOutbox, generation: number) {
  const payload = row.payload as { kind?: unknown; body?: unknown; ephemeral?: unknown };
  if (
    row.target !== "linear" ||
    !row.orderingKey ||
    row.op !== "activity" ||
    payload?.kind !== "thought" ||
    typeof payload.body !== "string"
  )
    return null;
  const { outbox } = q.t;
  const kind = sql.raw(jsonText(q.dialect, "payload", "kind"));
  const last = yield* q.one(
    q.orm
      .select({ id: outbox.id, payload: outbox.payload })
      .from(outbox)
      .where(
        and(
          eq(outbox.target, "linear"),
          eq(outbox.orderingKey, row.orderingKey),
          eq(outbox.deliveryGeneration, generation),
          inArray(outbox.status, ["pending", "sent"]),
          sql`(${outbox.op} = 'elicitation' OR (${outbox.op} = 'activity'
            AND ${kind} IN ('thought', 'response', 'error')))`,
        ),
      )
      .orderBy(desc(outbox.id))
      .limit(1),
  );
  if (last === undefined) return null;
  const stored = payloadOut(q, last.payload) as {
    kind?: unknown;
    body?: unknown;
    ephemeral?: unknown;
  };
  if (stored.kind !== "thought" || typeof stored.body !== "string") return null;
  if (stored.body.trim() !== payload.body.trim()) return null;
  if (payload.ephemeral === true && (stored.ephemeral === true || stored.ephemeral === 1))
    return null;
  return last.id;
}

function deliveryKind(row: NewOutbox): OutboxDelivery {
  if (row.target !== "linear") return "ordered";
  const payload = row.payload as { kind?: string; stateType?: string } | undefined;
  if (row.op === "elicitation") return "critical";
  if (row.op === "status") return payload?.stateType === "completed" ? "status" : "progress";
  if (row.op === "activity") {
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

function* getFenceSteps(q: Q, target: OutboxTarget, orderingKey: string) {
  const { outboxSessionFence: fence } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ generation: fence.generation, stopped: fence.stopped })
      .from(fence)
      .where(and(eq(fence.target, target), eq(fence.orderingKey, orderingKey))),
  );
  return { generation: row?.generation ?? 0, stopped: row?.stopped === 1 };
}

function mapOutbox(q: Q, row: typeof pgSchema.outbox.$inferSelect): OutboxRow {
  return {
    delivery: row.deliveryKind as OutboxDelivery,
    generation: row.deliveryGeneration,
    id: row.id,
    target: row.target as OutboxTarget,
    op: row.op,
    orderingKey: row.orderingKey,
    idempotencyKey: row.idempotencyKey,
    payload: payloadOut(q, row.payload),
    priority: row.priority,
    notBefore: row.notBefore,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    status: row.status as OutboxStatus,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
    lockedBy: row.lockedBy,
    lockedUntil: row.lockedUntil,
    error: row.error,
  };
}

export function linearSessionClosed(db: Database, sessionId: string, generation: number): boolean {
  return settled(sqliteDb(db).run((q) => linearSessionClosedSteps(q, sessionId, generation)));
}

export function* linearSessionClosedSteps(q: Q, sessionId: string, generation: number) {
  const { outbox } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(outbox)
      .where(
        and(
          eq(outbox.target, "linear"),
          eq(outbox.orderingKey, sessionId),
          eq(outbox.deliveryGeneration, generation),
          inArray(outbox.deliveryKind, ["terminal", "stop"]),
          ne(outbox.status, "dropped"),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export function pullRequestReadyQueued(
  db: Database,
  sessionId: string,
  generation: number,
): boolean {
  return settled(sqliteDb(db).run((q) => pullRequestReadyQueuedSteps(q, sessionId, generation)));
}

export function* pullRequestReadyQueuedSteps(q: Q, sessionId: string, generation: number) {
  const { outbox } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(outbox)
      .where(
        and(
          eq(outbox.target, "linear"),
          eq(outbox.orderingKey, sessionId),
          eq(outbox.deliveryGeneration, generation),
          likeOf(q)(outbox.idempotencyKey, "pull-request-ready:%"),
          ne(outbox.status, "dropped"),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

type SessionActivityDrop = { orderingKey: string; body: string; error: string; now: number };

export function* dropUnsentSessionActivitySteps(q: Q, input: SessionActivityDrop) {
  const { outbox } = q.t;
  yield* q.exec(
    q.orm
      .update(outbox)
      .set({ status: "dropped", error: input.error })
      .where(
        and(
          eq(outbox.target, "linear"),
          eq(outbox.orderingKey, input.orderingKey),
          eq(outbox.op, "activity"),
          eq(outbox.status, "pending"),
          eq(outbox.attempts, 0),
          unlockedAt(q, input.now),
          eq(jsonField(q, outbox.payload, "body"), input.body),
        ),
      ),
  );
}

export function dropUnsentSessionActivity(db: Database, input: SessionActivityDrop): void {
  settled(sqliteDb(db).run((q) => dropUnsentSessionActivitySteps(q, input)));
}

export function* linearOutboxKeyedSteps(q: Q, prefix: string) {
  const { outbox } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(outbox)
      .where(
        and(
          eq(outbox.target, "linear"),
          sql`substr(${outbox.idempotencyKey}, 1, ${prefix.length}) = ${prefix}`,
          ne(outbox.status, "dropped"),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export function linearOutboxKeyed(db: Database, prefix: string): boolean {
  return settled(sqliteDb(db).run((q) => linearOutboxKeyedSteps(q, prefix)));
}

/** The current delivery generation of a Linear session, 0 before its first fence. */
export function* linearSessionGenerationSteps(q: Q, sessionId: string) {
  return (yield* getFenceSteps(q, "linear", sessionId)).generation;
}

export function linearSessionGeneration(db: Database, sessionId: string): number {
  return settled(sqliteDb(db).run((q) => linearSessionGenerationSteps(q, sessionId)));
}

/**
 * Whether this generation has its final response: a pull request ready, merged or closed message.
 * With `rowId`, only a final response queued before that row or already sent counts.
 */
export function* sessionHasFinalResponseSteps(
  q: Q,
  sessionId: string,
  generation: number,
  rowId?: number,
) {
  const { outbox } = q.t;
  const prefixed = likeOf(q);
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(outbox)
      .where(
        and(
          eq(outbox.target, "linear"),
          eq(outbox.orderingKey, sessionId),
          eq(outbox.deliveryGeneration, generation),
          or(
            prefixed(outbox.idempotencyKey, "pull-request-ready:%"),
            prefixed(outbox.idempotencyKey, "merged:%"),
            prefixed(outbox.idempotencyKey, "closed:%"),
          ),
          ne(outbox.status, "dropped"),
          rowId === undefined ? undefined : or(lt(outbox.id, rowId), eq(outbox.status, "sent")),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export function sessionHasFinalResponse(
  db: Database,
  sessionId: string,
  generation: number,
  rowId?: number,
): boolean {
  return settled(
    sqliteDb(db).run((q) => sessionHasFinalResponseSteps(q, sessionId, generation, rowId)),
  );
}

export function* outboxKeyExistsSteps(q: Q, idempotencyKey: string) {
  const { outbox } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(outbox)
      .where(eq(outbox.idempotencyKey, idempotencyKey)),
  );
  return row !== undefined;
}

export function outboxKeyExists(db: Database, idempotencyKey: string): boolean {
  return settled(sqliteDb(db).run((q) => outboxKeyExistsSteps(q, idempotencyKey)));
}
