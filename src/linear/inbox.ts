import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import {
  claimInboxEvent,
  claimNextInboxEvent,
  clearSyncCursor,
  incrementSyncCounter,
  releaseInboxClaim,
  renewInboxClaim,
  type ClaimedInboxRow,
} from "../db";
import { promptMetadata, type AcceptedLinearEvent } from "./events";

export type CommitResult = {
  inserted: boolean;
  handled: boolean;
};

/** An unhandled intake event and where it is on its retry schedule. */
export type QueuedLinearEvent = {
  event: AcceptedLinearEvent;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
};

export type InboxClaim = { owner: string; now: number; leaseMs: number };

export type InboxStore = {
  commit(event: AcceptedLinearEvent): CommitResult;
  markHandled(dedupeKey: string): void;
  listUnhandled(): AcceptedLinearEvent[];
  claimNext(claim: InboxClaim): QueuedLinearEvent | null;
  claim(dedupeKey: string, claim: InboxClaim): QueuedLinearEvent | null;
  renew(dedupeKey: string, claim: InboxClaim): boolean;
  release(dedupeKey: string, owner: string): void;
  /** Records a failed attempt. `counted: false` reschedules without spending an attempt. */
  markFailed(
    dedupeKey: string,
    failure: { error: string; nextAttemptAt: number; counted: boolean },
  ): void;
  getCursor(name: string): number | null;
  setCursor(name: string, cursorMs: number): void;
  countCursor(name: string): number;
  clearCursor(name: string): void;
  get(dedupeKey: string): AcceptedLinearEvent | null;
};

type InboxRow = {
  dedupe_key: string;
  delivery_id: string | null;
  source: AcceptedLinearEvent["source"];
  action: AcceptedLinearEvent["action"];
  session_id: string | null;
  issue_id: string | null;
  activity_id: string | null;
  body: string | null;
  signal: string | null;
  updated_at_ms: number;
  payload: string;
  handled: number;
};

/** SQLite inbox. `commit` returns only after the row is committed. */
export function createInboxStore(db: Database): InboxStore {
  return {
    commit(event) {
      try {
        const insert = db.transaction(() => {
          db.run(
            `INSERT INTO inbox_event (
               dedupe_key, delivery_id, source, action, session_id, issue_id, activity_id,
               body, signal, updated_at_ms, payload, received_at, handled
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
            [
              event.dedupeKey,
              event.deliveryId,
              event.source,
              event.action,
              event.sessionId,
              event.issueId,
              event.activityId,
              event.body,
              event.signal,
              event.updatedAtMs,
              event.payload,
              Date.now(),
            ],
          );
        });
        insert.immediate();
        return { inserted: true, handled: false };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        journalCaught(error, "inbox.commit.transaction", null, "duplicate inbox delivery");
        const existing = findExisting(db, event);
        return { inserted: false, handled: existing?.handled === 1 };
      }
    },
    markHandled(dedupeKey) {
      db.run(
        "UPDATE inbox_event SET handled = 1, locked_by = NULL, locked_until = NULL WHERE dedupe_key = ?",
        [dedupeKey],
      );
    },
    listUnhandled() {
      const rows = db
        .query<InboxRow, []>(
          `SELECT dedupe_key, delivery_id, source, action, session_id, issue_id, activity_id,
                  body, signal, updated_at_ms, payload, handled
           FROM inbox_event WHERE handled = 0 ORDER BY received_at, dedupe_key`,
        )
        .all();
      return rows.map(mapRow);
    },
    claimNext(claim) {
      return queuedRow(claimNextInboxEvent(db, claim));
    },
    claim(dedupeKey, claim) {
      return queuedRow(claimInboxEvent(db, dedupeKey, claim));
    },
    renew(dedupeKey, claim) {
      return renewInboxClaim(db, dedupeKey, claim);
    },
    release(dedupeKey, owner) {
      releaseInboxClaim(db, dedupeKey, owner);
    },
    markFailed(dedupeKey, failure) {
      db.run(
        `UPDATE inbox_event
         SET attempts = attempts + ?, next_attempt_at = ?, last_error = ?,
             locked_by = NULL, locked_until = NULL
         WHERE dedupe_key = ?`,
        [failure.counted ? 1 : 0, failure.nextAttemptAt, failure.error.slice(0, 2000), dedupeKey],
      );
    },
    getCursor(name) {
      const row = db
        .query<{ cursor_ms: number }, [string]>("SELECT cursor_ms FROM sync_cursor WHERE name = ?")
        .get(name);
      return row?.cursor_ms ?? null;
    },
    setCursor(name, cursorMs) {
      db.run(
        `INSERT INTO sync_cursor (name, cursor_ms) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET cursor_ms = excluded.cursor_ms`,
        [name, cursorMs],
      );
    },
    countCursor(name) {
      return incrementSyncCounter(db, name);
    },
    clearCursor(name) {
      clearSyncCursor(db, name);
    },
    get(dedupeKey) {
      const row = db
        .query<InboxRow, [string]>(
          `SELECT dedupe_key, delivery_id, source, action, session_id, issue_id, activity_id,
                  body, signal, updated_at_ms, payload, handled
           FROM inbox_event WHERE dedupe_key = ?`,
        )
        .get(dedupeKey);
      return row === null ? null : mapRow(row);
    },
  };
}

function findExisting(db: Database, event: AcceptedLinearEvent): InboxRow | null {
  const byKey = db
    .query<InboxRow, [string]>(
      `SELECT dedupe_key, delivery_id, source, action, session_id, issue_id, activity_id,
              body, signal, updated_at_ms, payload, handled
       FROM inbox_event WHERE dedupe_key = ?`,
    )
    .get(event.dedupeKey);
  if (byKey !== null) return byKey;
  if (event.deliveryId === null) return null;
  return (
    db
      .query<InboxRow, [string]>(
        `SELECT dedupe_key, delivery_id, source, action, session_id, issue_id, activity_id,
                body, signal, updated_at_ms, payload, handled
         FROM inbox_event WHERE delivery_id = ?`,
      )
      .get(event.deliveryId) ?? null
  );
}

function queuedRow(row: ClaimedInboxRow | null): QueuedLinearEvent | null {
  if (row === null) return null;
  return {
    event: mapRow({
      dedupe_key: row.dedupeKey,
      delivery_id: row.deliveryId,
      source: row.source as AcceptedLinearEvent["source"],
      action: row.action as AcceptedLinearEvent["action"],
      session_id: row.sessionId,
      issue_id: row.issueId,
      activity_id: row.activityId,
      body: row.body,
      signal: row.signal,
      updated_at_ms: row.updatedAtMs,
      payload: row.payload,
      handled: row.handled,
    }),
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    lastError: row.lastError,
  };
}

function mapRow(row: InboxRow): AcceptedLinearEvent {
  return {
    dedupeKey: row.dedupe_key,
    deliveryId: row.delivery_id,
    source: row.source,
    action: row.action,
    sessionId: row.session_id,
    issueId: row.issue_id,
    activityId: row.activity_id,
    ...promptMetadata(row.payload),
    body: row.body,
    signal: row.signal,
    updatedAtMs: row.updated_at_ms,
    payload: row.payload,
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = "code" in error ? String(error.code) : "";
  return code.includes("SQLITE_CONSTRAINT") || error.message.includes("UNIQUE constraint");
}
