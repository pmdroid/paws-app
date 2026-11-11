import type { Database } from "bun:sqlite";
import { issueHasItemOutside, latestOpenIssueSession, sessionHasWorkItem } from "../db";
import type { AcceptedLinearEvent } from "./events";
import type { InboxStore } from "./inbox";
import type { LinearIssueOwnership } from "./issue-lifecycle";

export const REDELEGATION_CHECK_DELAY_MS = 60_000;
const NEW_SESSION_MARGIN_MS = 60_000;
const CLOSED_STATES = ["merged", "completed", "cancelled", "failed"];

export async function checkRedelegation(
  options: {
    db: Database;
    store: InboxStore;
    appUserId: string | null;
    inspect: (issueId: string) => Promise<LinearIssueOwnership>;
    onEvent: (event: AcceptedLinearEvent) => Promise<void | boolean> | void | boolean;
  },
  target: { issueId: string; delegatedAtMs: number },
): Promise<boolean> {
  const { db, store } = options;
  if (store.getCursor(`delegated:${target.issueId}`) !== target.delegatedAtMs) return false;
  const event = reusedSessionEvent(db, target);
  if (event === null || store.get(event.dedupeKey) !== null) return false;
  const issue = await options.inspect(target.issueId);
  if (options.appUserId === null || issue.delegateId !== options.appUserId) return false;
  const current = reusedSessionEvent(db, target);
  if (current === null || store.get(current.dedupeKey) !== null) return false;
  store.commit(current);
  await options.onEvent(current);
  store.markHandled(current.dedupeKey);
  return true;
}

function reusedSessionEvent(
  db: Database,
  target: { issueId: string; delegatedAtMs: number },
): AcceptedLinearEvent | null {
  if (issueHasItemOutside(db, target.issueId, CLOSED_STATES)) return null;
  const session = latestOpenIssueSession(db, target.issueId);
  if (session === null || session.createdAt > target.delegatedAtMs - NEW_SESSION_MARGIN_MS)
    return null;
  if (sessionHasWorkItem(db, session.sessionId)) return null;
  return {
    dedupeKey: `session:${session.sessionId}:created:${target.delegatedAtMs}`,
    deliveryId: null,
    source: "poll",
    action: "created",
    sessionId: session.sessionId,
    issueId: target.issueId,
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: target.delegatedAtMs,
    payload: JSON.stringify({ kind: "session", reason: "redelegated" }),
  };
}
