import type { Database } from "bun:sqlite";
import {
  delegationParentTaskKey,
  ensureLinearSessionSteps,
  workItemForSession,
  type Q,
  type Steps,
  type StoredLinearSession,
} from "../db";
import type { AcceptedLinearEvent } from "../linear";

export function* recordLinearSessionEventSteps(
  q: Q,
  event: AcceptedLinearEvent,
  now: number,
): Steps<StoredLinearSession | null> {
  const input = linearSessionInput(event, now);
  return input ? yield* ensureLinearSessionSteps(q, input) : null;
}

type LinearSessionInput = Parameters<typeof ensureLinearSessionSteps>[1];

function linearSessionInput(event: AcceptedLinearEvent, now: number): LinearSessionInput | null {
  if (!event.sessionId) return null;
  const raw: unknown = JSON.parse(event.payload);
  const payload = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return {
    sessionId: event.sessionId,
    issueId: event.issueId,
    organizationId: typeof payload.organizationId === "string" ? payload.organizationId : null,
    appUserId: typeof payload.appUserId === "string" ? payload.appUserId : null,
    creatorId: linearSessionCreatorId(event),
    now,
  };
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
    const taskKey = delegationParentTaskKey(db, delegationId);
    if (taskKey) return taskKey;
  }
  return `session:${session.sessionId}`;
}
