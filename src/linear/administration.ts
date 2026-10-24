import type { AcceptedLinearEvent } from "./events";
import { isRecord, readString } from "./read";

export type LinearInstallation = {
  organizationId: string;
  oauthClientId: string;
  appUserId: string;
};

export type LinearAdministration =
  | (Omit<LinearInstallation, "appUserId"> & { kind: "revoked"; createdAtMs: number })
  | (LinearInstallation & {
      kind: "teams";
      createdAtMs: number;
      canAccessAllPublicTeams: boolean;
      addedTeamIds: readonly string[];
      removedTeamIds: readonly string[];
    })
  | (LinearInstallation & {
      kind: "notification";
      createdAtMs: number;
      notificationId: string;
      action: string;
      issueId: string;
      teamId: string;
      actorId: string | null;
    });

const ISSUE_NOTIFICATIONS = new Set([
  "issueMention",
  "issueEmojiReaction",
  "issueCommentMention",
  "issueCommentReaction",
  "issueAssignedToYou",
  "issueUnassignedFromYou",
  "issueNewComment",
  "issueStatusChanged",
]);

export function parseLinearAdministration(event: AcceptedLinearEvent): LinearAdministration | null {
  const payload = verifiedPayload(event);
  if (payload === null) return null;
  const organizationId = id(payload, "organizationId");
  const oauthClientId = id(payload, "oauthClientId");
  const createdAt = readString(payload, "createdAt");
  const createdAtMs = createdAt === null ? NaN : Date.parse(createdAt);
  if (organizationId === null || oauthClientId === null || !Number.isFinite(createdAtMs))
    return null;
  const type = readString(payload, "type");
  const action = readString(payload, "action");
  const base = { organizationId, oauthClientId, createdAtMs };
  if (type === "OAuthApp" && action === "revoked") return { ...base, kind: "revoked" };
  const appUserId = id(payload, "appUserId");
  if (appUserId === null) return null;
  if (type === "PermissionChange" && action === "teamAccessChanged") {
    const addedTeamIds = ids(payload["addedTeamIds"]);
    const removedTeamIds = ids(payload["removedTeamIds"]);
    const canAccessAllPublicTeams = payload["canAccessAllPublicTeams"];
    if (
      addedTeamIds === null ||
      removedTeamIds === null ||
      typeof canAccessAllPublicTeams !== "boolean"
    )
      return null;
    if (addedTeamIds.some((team) => removedTeamIds.includes(team))) return null;
    return {
      ...base,
      appUserId,
      kind: "teams",
      addedTeamIds,
      removedTeamIds,
      canAccessAllPublicTeams,
    };
  }
  if (type !== "AppUserNotification" || action === null || !ISSUE_NOTIFICATIONS.has(action))
    return null;
  const notification = child(payload, "notification");
  if (notification === null || readString(notification, "type") !== action) return null;
  if (id(notification, "userId") !== appUserId) return null;
  const notificationId = id(notification, "id");
  const issue = child(notification, "issue");
  const issueId = reference(notification, "issueId", issue);
  const teamId = issue === null ? null : reference(issue, "teamId", child(issue, "team"));
  const actor = child(notification, "actor");
  const actorId = reference(notification, "actorId", actor);
  if (notificationId === null || issueId === null || teamId === null) return null;
  if (id(notification, "actorId") !== null && actor !== null && actorId === null) return null;
  return {
    ...base,
    appUserId,
    kind: "notification",
    notificationId,
    action,
    issueId,
    teamId,
    actorId,
  };
}

export function parseLinearSessionInstallation(
  event: AcceptedLinearEvent,
): (LinearInstallation & { sessionId: string; teamId: string | null }) | null {
  const payload = verifiedPayload(event);
  if (payload === null || readString(payload, "type") !== "AgentSessionEvent") return null;
  const session = child(payload, "agentSession");
  if (session === null) return null;
  const sessionId = id(session, "id");
  const organizationId = id(payload, "organizationId");
  const oauthClientId = id(payload, "oauthClientId");
  const appUserId = id(payload, "appUserId");
  if (sessionId === null || organizationId === null || oauthClientId === null || appUserId === null)
    return null;
  if (event.sessionId !== sessionId) return null;
  if (id(session, "organizationId") !== null && id(session, "organizationId") !== organizationId)
    return null;
  if (id(session, "appUserId") !== null && id(session, "appUserId") !== appUserId) return null;
  const issue = child(session, "issue");
  const teamId = issue === null ? null : reference(issue, "teamId", child(issue, "team"));
  const issueId = reference(session, "issueId", issue);
  if (issue !== null && (issueId === null || teamId === null)) return null;
  if (event.issueId !== issueId) return null;
  return { sessionId, organizationId, oauthClientId, appUserId, teamId };
}

export function parseLinearUndelegation(
  event: AcceptedLinearEvent,
  appUserId: string | null,
): { organizationId: string; appUserId: string; issueId: string; createdAtMs: number } | null {
  const payload = verifiedPayload(event);
  if (payload === null || appUserId === null || readString(payload, "type") !== "Issue")
    return null;
  const data = child(payload, "data");
  const previous = child(payload, "updatedFrom");
  const organizationId = id(payload, "organizationId");
  const issueId = data === null ? null : id(data, "id");
  const createdAtMs = Date.parse(readString(payload, "createdAt") ?? "");
  if (
    data === null ||
    previous === null ||
    organizationId === null ||
    issueId === null ||
    !Number.isFinite(createdAtMs) ||
    readString(previous, "delegateId") !== appUserId ||
    readString(data, "delegateId") === appUserId
  )
    return null;
  return { organizationId, appUserId, issueId, createdAtMs };
}

export type LinearIssueClosedState = "completed" | "canceled";

/** An issue moved to a completed or canceled workflow state, from a webhook or the catch-up poll. */
export type LinearIssueClosed = {
  issueId: string;
  /** Null for a polled event: the poll is already scoped to this installation. */
  organizationId: string | null;
  identifier: string | null;
  stateType: LinearIssueClosedState;
  /** When Linear closed the issue. Tasks created after it are left alone. */
  closedAtMs: number;
};

/** The polled event payload for a closed issue. `src/linear/poller.ts` writes it. */
export const CLOSED_ISSUE_EVENT = "closed";

export function closedIssueState(value: string | null): LinearIssueClosedState | null {
  return value === "completed" || value === "canceled" ? value : null;
}

/**
 * Reads only what the event delivered. A webhook counts when its `updatedFrom` shows the
 * state changed; a polled event counts when the poll saw the issue in a closed state.
 */
export function parseLinearIssueClosed(event: AcceptedLinearEvent): LinearIssueClosed | null {
  if (event.source === "poll") return polledIssueClosed(event);
  const payload = verifiedPayload(event);
  if (payload === null || readString(payload, "type") !== "Issue") return null;
  if (readString(payload, "action") !== "update") return null;
  const data = child(payload, "data");
  const previous = child(payload, "updatedFrom");
  const organizationId = id(payload, "organizationId");
  const issueId = data === null ? null : id(data, "id");
  if (data === null || previous === null || organizationId === null || issueId === null)
    return null;
  if (!("stateId" in previous)) return null;
  const state = child(data, "state");
  const stateType = closedIssueState(state === null ? null : readString(state, "type"));
  if (stateType === null) return null;
  const closedAtMs = Date.parse(
    readString(data, stateType === "completed" ? "completedAt" : "canceledAt") ??
      readString(payload, "createdAt") ??
      "",
  );
  if (!Number.isFinite(closedAtMs)) return null;
  return {
    issueId,
    organizationId,
    identifier: readString(data, "identifier"),
    stateType,
    closedAtMs,
  };
}

/** A webhook that moved an issue to another Linear project, or out of every project. */
export type LinearIssueProjectChange = {
  issueId: string;
  organizationId: string;
  project: { id: string; name: string | null } | null;
};

/**
 * Reads only what the event delivered: an issue update whose `updatedFrom` names `projectId`.
 * The name comes from the payload's `project`, when Linear included it.
 */
export function parseLinearIssueProjectChange(
  event: AcceptedLinearEvent,
): LinearIssueProjectChange | null {
  const payload = verifiedPayload(event);
  if (payload === null || readString(payload, "type") !== "Issue") return null;
  if (readString(payload, "action") !== "update") return null;
  const data = child(payload, "data");
  const previous = child(payload, "updatedFrom");
  const organizationId = id(payload, "organizationId");
  const issueId = data === null ? null : id(data, "id");
  if (data === null || previous === null || organizationId === null || issueId === null)
    return null;
  if (!("projectId" in previous)) return null;
  const nested = child(data, "project");
  if (data["projectId"] === null || (!("projectId" in data) && data["project"] === null))
    return { issueId, organizationId, project: null };
  const projectId = reference(data, "projectId", nested);
  if (projectId === null) return null;
  const name = nested === null ? null : readString(nested, "name");
  return { issueId, organizationId, project: { id: projectId, name: name?.trim() || null } };
}

function polledIssueClosed(event: AcceptedLinearEvent): LinearIssueClosed | null {
  if (event.issueId === null) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(event.payload);
  } catch {
    return null;
  }
  if (!isRecord(payload) || readString(payload, "kind") !== CLOSED_ISSUE_EVENT) return null;
  const stateType = closedIssueState(readString(payload, "stateType"));
  const closedAtMs = payload["closedAtMs"];
  if (stateType === null || typeof closedAtMs !== "number" || !Number.isFinite(closedAtMs))
    return null;
  return {
    issueId: event.issueId,
    organizationId: null,
    identifier: readString(payload, "identifier"),
    stateType,
    closedAtMs,
  };
}

export function parseLinearUserChange(event: AcceptedLinearEvent): {
  organizationId: string;
  userId: string;
  active: boolean | null;
  guest: boolean | null;
} | null {
  const payload = verifiedPayload(event);
  if (payload === null || readString(payload, "type") !== "User") return null;
  const data = child(payload, "data");
  const organizationId = id(payload, "organizationId");
  const userId = data === null ? null : id(data, "id");
  if (data === null || organizationId === null || userId === null) return null;
  const flag = (key: string) => (typeof data[key] === "boolean" ? data[key] : null);
  return {
    organizationId,
    userId,
    active: readString(payload, "action") === "remove" ? false : flag("active"),
    guest: flag("guest"),
  };
}

export function matchesLinearInstallation(
  event: LinearAdministration,
  installation: LinearInstallation,
): boolean {
  return (
    event.organizationId === installation.organizationId &&
    event.oauthClientId === installation.oauthClientId &&
    (event.kind === "revoked" || event.appUserId === installation.appUserId)
  );
}

function verifiedPayload(event: AcceptedLinearEvent): Record<string, unknown> | null {
  if (event.source !== "webhook" || event.deliveryId === null) return null;
  try {
    const parsed: unknown = JSON.parse(event.payload);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function child(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  return isRecord(record[key]) ? record[key] : null;
}

function id(record: Record<string, unknown>, key: string): string | null {
  const value = readString(record, key);
  return value?.trim() ? value : null;
}

function reference(
  record: Record<string, unknown>,
  key: string,
  nested: Record<string, unknown> | null,
): string | null {
  const direct = id(record, key);
  const nestedId = nested === null ? null : id(nested, "id");
  return direct !== null && nestedId !== null && direct !== nestedId ? null : (direct ?? nestedId);
}

function ids(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.trim() === "")
  )
    return null;
  return [...new Set(value as string[])];
}
