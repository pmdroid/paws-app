import { and, asc, eq, exists, gte, inArray, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { type Db, type Q, type Steps } from "./db";
import { jsonField, jsonFromText, jsonText } from "./json-text";

export type InboxEventRow = {
  dedupe_key: string;
  delivery_id: string | null;
  source: string;
  action: string;
  session_id: string | null;
  issue_id: string | null;
  activity_id: string | null;
  body: string | null;
  signal: string | null;
  updated_at_ms: number;
  payload: string;
  handled: number;
};

export type NewInboxEvent = {
  dedupeKey: string;
  deliveryId: string | null;
  source: string;
  action: string;
  sessionId: string | null;
  issueId: string | null;
  activityId: string | null;
  body: string | null;
  signal: string | null;
  updatedAtMs: number;
  payload: string;
  receivedAt: number;
};

function rowColumns(q: Q) {
  const e = q.t.inboxEvent;
  return {
    dedupe_key: e.dedupeKey,
    delivery_id: e.deliveryId,
    source: e.source,
    action: e.action,
    session_id: e.sessionId,
    issue_id: e.issueId,
    activity_id: e.activityId,
    body: e.body,
    signal: e.signal,
    updated_at_ms: e.updatedAtMs,
    payload: jsonText(q, e.payload),
    handled: e.handled,
  };
}

function* inboxEventRowsSteps(q: Q, where: SQL | undefined): Steps<InboxEventRow[]> {
  const e = q.t.inboxEvent;
  return yield* q.all(
    q.orm.select(rowColumns(q)).from(e).where(where).orderBy(asc(e.receivedAt), asc(e.dedupeKey)),
  );
}

export function* insertInboxEventSteps(q: Q, row: NewInboxEvent): Steps<boolean> {
  const e = q.t.inboxEvent;
  const inserted = yield* q.all(
    q.orm
      .insert(e)
      .values({ ...row, payload: jsonFromText(q, row.payload), handled: 0 })
      .onConflictDoNothing()
      .returning({ dedupeKey: e.dedupeKey }),
  );
  return inserted.length === 1;
}

export async function insertInboxEvent(store: Db, row: NewInboxEvent): Promise<boolean> {
  return store.transaction((q) => insertInboxEventSteps(q, row));
}

type InboxIdentity = Pick<
  NewInboxEvent,
  "dedupeKey" | "source" | "action" | "sessionId" | "issueId" | "activityId" | "signal"
> & { payload: unknown };

function staleReintake(payload: unknown): boolean {
  const parsed: unknown = typeof payload === "string" ? JSON.parse(payload) : payload;
  return (
    typeof parsed === "object" && parsed !== null && "reason" in parsed && parsed.reason === "stale"
  );
}

function duplicateMatch(event: InboxIdentity, other: Q["t"]["inboxEvent"]): SQL | null {
  if (event.signal === "stop") return null;
  const { action, source, sessionId, issueId, activityId, dedupeKey } = event;
  if (action === "created" && issueId !== null && dedupeKey === `issue:${issueId}:intake`)
    return and(
      eq(other.action, "created"),
      eq(other.issueId, issueId),
      sessionId === null ? undefined : eq(other.sessionId, sessionId),
      sql`${other.dedupeKey} = 'session:' || ${other.sessionId} || ':created'`,
    )!;
  if (
    action === "created" &&
    sessionId !== null &&
    dedupeKey === `session:${sessionId}:created` &&
    !(source === "poll" && staleReintake(event.payload))
  )
    return and(
      eq(other.action, "created"),
      eq(other.sessionId, sessionId),
      sql`${other.dedupeKey} = 'issue:' || ${other.issueId} || ':intake'`,
    )!;
  if (action === "prompted" && source === "poll" && dedupeKey === `activity:${activityId}`)
    return and(eq(other.source, "webhook"), eq(other.activityId, activityId!))!;
  return null;
}

function* inboxDuplicateSteps(
  q: Q,
  event: InboxIdentity,
  receivedAt: number | null,
): Steps<{ dedupeKey: string; handled: number } | null> {
  const other = q.t.inboxEvent;
  const match = duplicateMatch(event, other);
  if (match === null) return null;
  const earlier =
    receivedAt === null
      ? undefined
      : sql`(${other.receivedAt}, ${other.dedupeKey}) < (${receivedAt}, ${event.dedupeKey})`;
  const row = yield* q.one(
    q.orm
      .select({ dedupeKey: other.dedupeKey, handled: other.handled })
      .from(other)
      .where(and(match, ne(other.dedupeKey, event.dedupeKey), earlier))
      .orderBy(asc(other.receivedAt), asc(other.dedupeKey))
      .limit(1),
  );
  return row ?? null;
}

export function* commitInboxEventSteps(
  q: Q,
  row: NewInboxEvent,
): Steps<{ inserted: boolean; mergedInto: string | null }> {
  const e = q.t.inboxEvent;
  if (duplicateMatch(row, e) !== null)
    for (const scope of [row.issueId, row.sessionId])
      if (scope !== null)
        yield* q.exec(
          q.orm
            .select({ lock: sql`pg_advisory_xact_lock(hashtextextended(${`inbox:${scope}`}, 0))` })
            .from(sql`(SELECT 1) AS lock_scope`),
        );
  const survivor = yield* inboxDuplicateSteps(q, row, null);
  const inserted = yield* q.all(
    q.orm
      .insert(e)
      .values({ ...row, payload: jsonFromText(q, row.payload), handled: survivor ? 1 : 0 })
      .onConflictDoNothing()
      .returning({ dedupeKey: e.dedupeKey }),
  );
  if (inserted.length === 0) return { inserted: false, mergedInto: null };
  if (survivor?.handled === 0 && row.action === "created")
    yield* q.exec(
      q.orm
        .update(e)
        .set({
          payload: sql`${e.payload} || ${jsonFromText(q, row.payload)}`,
          body: sql`COALESCE(${row.body}, ${e.body})`,
          activityId: sql`COALESCE(${row.activityId}, ${e.activityId})`,
          updatedAtMs: sql`GREATEST(${e.updatedAtMs}, ${row.updatedAtMs})`,
        })
        .where(eq(e.dedupeKey, survivor.dedupeKey)),
    );
  return { inserted: survivor === null, mergedInto: survivor?.dedupeKey ?? null };
}

export async function commitInboxEvent(store: Db, row: NewInboxEvent) {
  return store.transaction((q) => commitInboxEventSteps(q, row));
}

export async function queuedDuplicateOf(store: Db, dedupeKey: string): Promise<string | null> {
  return store.run(function* (q) {
    const e = q.t.inboxEvent;
    const row = yield* q.one(q.orm.select().from(e).where(eq(e.dedupeKey, dedupeKey)));
    if (row === undefined) return null;
    return (yield* inboxDuplicateSteps(q, row, row.receivedAt))?.dedupeKey ?? null;
  });
}

export async function sessionWebhookSince(
  store: Db,
  sessionId: string,
  sinceMs: number,
): Promise<boolean> {
  return store.run(function* (q) {
    const e = q.t.inboxEvent;
    const row = yield* q.one(
      q.orm
        .select({ dedupeKey: e.dedupeKey })
        .from(e)
        .where(and(eq(e.sessionId, sessionId), eq(e.source, "webhook"), gte(e.receivedAt, sinceMs)))
        .limit(1),
    );
    return row !== undefined;
  });
}

export function* markInboxEventHandledSteps(q: Q, dedupeKey: string) {
  const e = q.t.inboxEvent;
  yield* q.exec(
    q.orm
      .update(e)
      .set({ handled: 1, lockedBy: null, lockedUntil: null })
      .where(eq(e.dedupeKey, dedupeKey)),
  );
}

export async function markInboxEventHandled(store: Db, dedupeKey: string): Promise<void> {
  return store.run((q) => markInboxEventHandledSteps(q, dedupeKey));
}

export function* unhandledInboxEventsSteps(q: Q) {
  return yield* inboxEventRowsSteps(q, eq(q.t.inboxEvent.handled, 0));
}

export async function unhandledInboxEvents(store: Db): Promise<InboxEventRow[]> {
  return store.run((q) => unhandledInboxEventsSteps(q));
}

export function* inboxEventByKeySteps(q: Q, dedupeKey: string) {
  const [row] = yield* inboxEventRowsSteps(q, eq(q.t.inboxEvent.dedupeKey, dedupeKey));
  return row ?? null;
}

export async function inboxEventByKey(store: Db, dedupeKey: string): Promise<InboxEventRow | null> {
  return store.run((q) => inboxEventByKeySteps(q, dedupeKey));
}

export function* inboxEventByDeliverySteps(q: Q, deliveryId: string) {
  const [row] = yield* inboxEventRowsSteps(q, eq(q.t.inboxEvent.deliveryId, deliveryId));
  return row ?? null;
}

export async function inboxEventByDelivery(
  store: Db,
  deliveryId: string,
): Promise<InboxEventRow | null> {
  return store.run((q) => inboxEventByDeliverySteps(q, deliveryId));
}

type InboxFailure = { error: string; nextAttemptAt: number; counted: boolean };

export function* markInboxEventFailedSteps(q: Q, dedupeKey: string, failure: InboxFailure) {
  const e = q.t.inboxEvent;
  yield* q.exec(
    q.orm
      .update(e)
      .set({
        attempts: sql`${e.attempts} + ${failure.counted ? 1 : 0}`,
        nextAttemptAt: failure.nextAttemptAt,
        lastError: failure.error.slice(0, 2000),
        lockedBy: null,
        lockedUntil: null,
      })
      .where(eq(e.dedupeKey, dedupeKey)),
  );
}

export async function markInboxEventFailed(
  store: Db,
  dedupeKey: string,
  failure: InboxFailure,
): Promise<void> {
  return store.run((q) => markInboxEventFailedSteps(q, dedupeKey, failure));
}

export function* syncCursorSteps(q: Q, name: string): Steps<number | null> {
  const c = q.t.syncCursor;
  const row = yield* q.one(q.orm.select({ cursorMs: c.cursorMs }).from(c).where(eq(c.name, name)));
  return row?.cursorMs ?? null;
}

export async function syncCursor(store: Db, name: string): Promise<number | null> {
  return store.run((q) => syncCursorSteps(q, name));
}

export function* setSyncCursorSteps(q: Q, name: string, cursorMs: number) {
  const c = q.t.syncCursor;
  yield* q.exec(
    q.orm
      .insert(c)
      .values({ name, cursorMs })
      .onConflictDoUpdate({ target: c.name, set: { cursorMs } }),
  );
}

export async function setSyncCursor(store: Db, name: string, cursorMs: number): Promise<void> {
  return store.run((q) => setSyncCursorSteps(q, name, cursorMs));
}

export function* pruneHandledInboxEventsSteps(q: Q, cutoff: number, limit: number): Steps<number> {
  const e = q.t.inboxEvent;
  const newer = alias(e, "newer");
  const prunable = q.orm
    .select({ dedupeKey: e.dedupeKey })
    .from(e)
    .where(
      and(
        eq(e.handled, 1),
        eq(e.action, "other"),
        lt(e.receivedAt, cutoff),
        or(
          sql`COALESCE(${jsonField(q, e.payload, "type")}, '') <> 'Issue'`,
          exists(
            q.orm
              .select({ one: sql`1` })
              .from(newer)
              .where(
                and(
                  eq(jsonField(q, newer.payload, "type"), "Issue"),
                  eq(
                    jsonField(q, newer.payload, "data", "id"),
                    jsonField(q, e.payload, "data", "id"),
                  ),
                  eq(
                    jsonField(q, newer.payload, "organizationId"),
                    jsonField(q, e.payload, "organizationId"),
                  ),
                  sql`(${newer.updatedAtMs}, ${newer.receivedAt}) > (${e.updatedAtMs}, ${e.receivedAt})`,
                ),
              ),
          ),
        ),
      ),
    )
    .limit(limit);
  const deleted = yield* q.all(
    q.orm.delete(e).where(inArray(e.dedupeKey, prunable)).returning({ dedupeKey: e.dedupeKey }),
  );
  return deleted.length;
}
