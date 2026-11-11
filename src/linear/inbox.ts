import {
  claimInboxEvent,
  claimNextInboxEvent,
  clearSyncCursor,
  inboxEventByDelivery,
  inboxEventByKey,
  incrementSyncCounter,
  insertInboxEvent,
  markInboxEventFailed,
  markInboxEventHandled,
  releaseInboxClaim,
  renewInboxClaim,
  setSyncCursor,
  syncCursor,
  unhandledInboxEvents,
  type ClaimedInboxRow,
  type Db,
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
  commit(event: AcceptedLinearEvent): Promise<CommitResult>;
  markHandled(dedupeKey: string): Promise<void>;
  listUnhandled(): Promise<AcceptedLinearEvent[]>;
  claimNext(claim: InboxClaim): Promise<QueuedLinearEvent | null>;
  claim(dedupeKey: string, claim: InboxClaim): Promise<QueuedLinearEvent | null>;
  renew(dedupeKey: string, claim: InboxClaim): Promise<boolean>;
  release(dedupeKey: string, owner: string): Promise<void>;
  /** Records a failed attempt. `counted: false` reschedules without spending an attempt. */
  markFailed(
    dedupeKey: string,
    failure: { error: string; nextAttemptAt: number; counted: boolean },
  ): Promise<void>;
  getCursor(name: string): Promise<number | null>;
  setCursor(name: string, cursorMs: number): Promise<void>;
  countCursor(name: string): Promise<number>;
  clearCursor(name: string): Promise<void>;
  get(dedupeKey: string): Promise<AcceptedLinearEvent | null>;
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

/** The inbox. `commit` resolves only after the row is committed. */
export function createInboxStore(db: Db): InboxStore {
  return {
    async commit(event) {
      const inserted = await insertInboxEvent(db, {
        dedupeKey: event.dedupeKey,
        deliveryId: event.deliveryId,
        source: event.source,
        action: event.action,
        sessionId: event.sessionId,
        issueId: event.issueId,
        activityId: event.activityId,
        body: event.body,
        signal: event.signal,
        updatedAtMs: event.updatedAtMs,
        payload: event.payload,
        receivedAt: Date.now(),
      });
      if (inserted) return { inserted: true, handled: false };
      const existing = await findExisting(db, event);
      return { inserted: false, handled: existing?.handled === 1 };
    },
    markHandled: (dedupeKey) => markInboxEventHandled(db, dedupeKey),
    async listUnhandled() {
      return ((await unhandledInboxEvents(db)) as InboxRow[]).map(mapRow);
    },
    async claimNext(claim) {
      return queuedRow(await claimNextInboxEvent(db, claim));
    },
    async claim(dedupeKey, claim) {
      return queuedRow(await claimInboxEvent(db, dedupeKey, claim));
    },
    renew: (dedupeKey, claim) => renewInboxClaim(db, dedupeKey, claim),
    release: (dedupeKey, owner) => releaseInboxClaim(db, dedupeKey, owner),
    markFailed: (dedupeKey, failure) => markInboxEventFailed(db, dedupeKey, failure),
    getCursor: (name) => syncCursor(db, name),
    setCursor: (name, cursorMs) => setSyncCursor(db, name, cursorMs),
    countCursor: (name) => incrementSyncCounter(db, name),
    clearCursor: (name) => clearSyncCursor(db, name),
    async get(dedupeKey) {
      const row = (await inboxEventByKey(db, dedupeKey)) as InboxRow | null;
      return row === null ? null : mapRow(row);
    },
  };
}

async function findExisting(db: Db, event: AcceptedLinearEvent): Promise<InboxRow | null> {
  const byKey = (await inboxEventByKey(db, event.dedupeKey)) as InboxRow | null;
  if (byKey !== null) return byKey;
  if (event.deliveryId === null) return null;
  return (await inboxEventByDelivery(db, event.deliveryId)) as InboxRow | null;
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
