import { asc, eq, sql, type SQL } from "drizzle-orm";
import { type Db, type Q, type Steps } from "./db";
import { jsonFromText, jsonText } from "./json-text";

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
