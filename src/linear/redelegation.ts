import { issueHasItemOutside, latestOpenIssueSession, sessionHasWorkItem, type Db } from "../db";
import { journal } from "../journal";
import type { AcceptedLinearEvent } from "./events";
import type { InboxStore } from "./inbox";
import type { LinearIssueOwnership } from "./issue-lifecycle";
import type { StartedLinearSession } from "./start-session";

export const REDELEGATION_CHECK_DELAY_MS = 60_000;
const NEW_SESSION_MARGIN_MS = 60_000;
const CLOSED_STATES = ["merged", "completed", "cancelled", "failed"];

type Redelegation = { event: AcceptedLinearEvent } | { usedSessionId: string };

export async function checkRedelegation(
  options: {
    db: Db;
    store: InboxStore;
    appUserId: string | null;
    inspect: (issueId: string) => Promise<LinearIssueOwnership>;
    onEvent: (event: AcceptedLinearEvent) => Promise<void | boolean> | void | boolean;
    startSession?: (issueId: string) => Promise<StartedLinearSession>;
  },
  target: { issueId: string; delegatedAtMs: number },
): Promise<boolean> {
  const { store } = options;
  const { db } = options;
  const startedKey = `delegated:${target.issueId}:session`;
  if ((await store.getCursor(`delegated:${target.issueId}`)) !== target.delegatedAtMs) return false;
  if (!(await pending(db, store, target, startedKey))) return false;
  const issue = await options.inspect(target.issueId);
  if (options.appUserId === null || issue.delegateId !== options.appUserId) return false;
  const current = await redelegation(db, target);
  if (current === null || !(await pending(db, store, target, startedKey, current))) return false;
  if ("usedSessionId" in current) {
    if (!options.startSession) return false;
    await store.setCursor(startedKey, target.delegatedAtMs);
    try {
      const started = await options.startSession(target.issueId);
      journal(
        `redelegation_new_session issue=${target.issueId} old_session=${current.usedSessionId} new_session=${started.id}`,
      );
      return true;
    } catch (error) {
      await store.clearCursor(startedKey);
      journal(
        `redelegation_new_session_failed issue=${target.issueId} old_session=${current.usedSessionId} reason=${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }
  await store.commit(current.event);
  await options.onEvent(current.event);
  await store.markHandled(current.event.dedupeKey);
  return true;
}

async function pending(
  db: Db,
  store: InboxStore,
  target: { issueId: string; delegatedAtMs: number },
  startedKey: string,
  found?: Redelegation,
): Promise<boolean> {
  const current = found ?? (await redelegation(db, target));
  if (current === null) return false;
  if ("usedSessionId" in current)
    return (await store.getCursor(startedKey)) !== target.delegatedAtMs;
  return (await store.get(current.event.dedupeKey)) === null;
}

async function redelegation(
  db: Db,
  target: { issueId: string; delegatedAtMs: number },
): Promise<Redelegation | null> {
  if (await issueHasItemOutside(db, target.issueId, CLOSED_STATES)) return null;
  const session = await latestOpenIssueSession(db, target.issueId);
  if (session === null || session.createdAt > target.delegatedAtMs - NEW_SESSION_MARGIN_MS)
    return null;
  if (await sessionHasWorkItem(db, session.sessionId)) return { usedSessionId: session.sessionId };
  return {
    event: {
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
    },
  };
}
