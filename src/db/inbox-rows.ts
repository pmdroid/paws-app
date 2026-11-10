import type { Database } from "bun:sqlite";
import { asc, eq, sql, type SQL } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";
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

export function insertInboxEvent(db: Database, row: NewInboxEvent): boolean {
  return settled(sqliteDb(db).transaction((q) => insertInboxEventSteps(q, row)));
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

export function markInboxEventHandled(db: Database, dedupeKey: string): void {
  settled(sqliteDb(db).run((q) => markInboxEventHandledSteps(q, dedupeKey)));
}

export function* unhandledInboxEventsSteps(q: Q) {
  return yield* inboxEventRowsSteps(q, eq(q.t.inboxEvent.handled, 0));
}

export function unhandledInboxEvents(db: Database): InboxEventRow[] {
  return settled(sqliteDb(db).run((q) => unhandledInboxEventsSteps(q)));
}

export function* inboxEventByKeySteps(q: Q, dedupeKey: string) {
  const [row] = yield* inboxEventRowsSteps(q, eq(q.t.inboxEvent.dedupeKey, dedupeKey));
  return row ?? null;
}

export function inboxEventByKey(db: Database, dedupeKey: string): InboxEventRow | null {
  return settled(sqliteDb(db).run((q) => inboxEventByKeySteps(q, dedupeKey)));
}

export function* inboxEventByDeliverySteps(q: Q, deliveryId: string) {
  const [row] = yield* inboxEventRowsSteps(q, eq(q.t.inboxEvent.deliveryId, deliveryId));
  return row ?? null;
}

export function inboxEventByDelivery(db: Database, deliveryId: string): InboxEventRow | null {
  return settled(sqliteDb(db).run((q) => inboxEventByDeliverySteps(q, deliveryId)));
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

export function markInboxEventFailed(db: Database, dedupeKey: string, failure: InboxFailure) {
  settled(sqliteDb(db).run((q) => markInboxEventFailedSteps(q, dedupeKey, failure)));
}

export function* syncCursorSteps(q: Q, name: string): Steps<number | null> {
  const c = q.t.syncCursor;
  const row = yield* q.one(q.orm.select({ cursorMs: c.cursorMs }).from(c).where(eq(c.name, name)));
  return row?.cursorMs ?? null;
}

export function syncCursor(db: Database, name: string): number | null {
  return settled(sqliteDb(db).run((q) => syncCursorSteps(q, name)));
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

export function setSyncCursor(db: Database, name: string, cursorMs: number): void {
  settled(sqliteDb(db).run((q) => setSyncCursorSteps(q, name, cursorMs)));
}
