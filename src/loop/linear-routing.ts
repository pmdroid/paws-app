import type { Database } from "bun:sqlite";
import { parentTaskKeySql } from "../core";
import { ensureLinearSession, workItemForSession, type StoredLinearSession } from "../db";
import type { AcceptedLinearEvent } from "../linear";

export function recordLinearSessionEvent(
  db: Database,
  event: AcceptedLinearEvent,
  now: number,
): StoredLinearSession | null {
  if (!event.sessionId) return null;
  const raw: unknown = JSON.parse(event.payload);
  const payload = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return ensureLinearSession(db, {
    sessionId: event.sessionId,
    issueId: event.issueId,
    organizationId: typeof payload.organizationId === "string" ? payload.organizationId : null,
    appUserId: typeof payload.appUserId === "string" ? payload.appUserId : null,
    creatorId: linearSessionCreatorId(event),
    now,
  });
}

export function linearSessionCreatorId(event: AcceptedLinearEvent): string | null {
  const raw: unknown = JSON.parse(event.payload);
  const payload = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const session =
    payload["agentSession"] && typeof payload["agentSession"] === "object"
      ? (payload["agentSession"] as Record<string, unknown>)
      : {};
  const creator =
    session["creator"] && typeof session["creator"] === "object"
      ? (session["creator"] as Record<string, unknown>)
      : {};
  return typeof session["creatorId"] === "string"
    ? session["creatorId"]
    : typeof creator["id"] === "string"
      ? creator["id"]
      : null;
}

export function sessionTaskKey(db: Database, session: StoredLinearSession): string {
  const delegationId =
    workItemForSession(db, session.sessionId)?.delegationId ?? session.delegationId;
  if (delegationId) {
    const row = db
      .query<{ task_key: string | null }, [string]>(
        `SELECT ${parentTaskKeySql("work_item")} AS task_key FROM work_item WHERE delegation_id = ? ORDER BY created_at, position, id LIMIT 1`,
      )
      .get(delegationId);
    if (row?.task_key) return row.task_key;
  }
  return `session:${session.sessionId}`;
}
