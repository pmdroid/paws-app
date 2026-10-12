import type { Database } from "bun:sqlite";
import { ensureLinearSession, type StoredLinearSession } from "../db";
import type { AcceptedLinearEvent } from "../linear";

export function recordLinearSessionEvent(
  db: Database,
  event: AcceptedLinearEvent,
  now: number,
): StoredLinearSession | null {
  if (!event.sessionId) return null;
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
  return ensureLinearSession(db, {
    sessionId: event.sessionId,
    issueId: event.issueId,
    organizationId: typeof payload.organizationId === "string" ? payload.organizationId : null,
    appUserId: typeof payload.appUserId === "string" ? payload.appUserId : null,
    creatorId:
      typeof session["creatorId"] === "string"
        ? session["creatorId"]
        : typeof creator["id"] === "string"
          ? creator["id"]
          : null,
    now,
  });
}

export function sessionTaskKey(db: Database, session: StoredLinearSession): string {
  if (session.epicId) {
    const row = db
      .query<{ task_key: string | null }, [string]>("SELECT task_key FROM epic WHERE id = ?")
      .get(session.epicId);
    if (row?.task_key) return row.task_key;
  }
  return `session:${session.sessionId}`;
}
