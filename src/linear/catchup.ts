import { linearBudget, type LinearRateBudget } from "./budget";
import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";

/**
 * One GraphQL document per tick: team issues updated after the cursor,
 * plus comments and agent activities updated after the same cursor.
 */
const INTAKE_QUERY = `query IntakePoll($team: TeamFilter!, $since: DateTimeOrDuration!, $issueAfter: String, $commentAfter: String, $activityAfter: String, $sessionAfter: String, $includeIssues: Boolean!, $includeComments: Boolean!, $includeActivities: Boolean!, $includeSessions: Boolean!) {
  viewer { id }
  agentSessions(first: 50, after: $sessionAfter, orderBy: updatedAt, includeArchived: true) @include(if: $includeSessions) {
    nodes { id status createdAt updatedAt endedAt dismissedAt archivedAt appUser { id } issue { id team { id key } } }
    pageInfo { hasNextPage endCursor }
  }
  issues(
    first: 50
    after: $issueAfter
    orderBy: updatedAt
    filter: { updatedAt: { gt: $since }, team: $team }
  ) @include(if: $includeIssues) {
    nodes {
      id
      identifier
      updatedAt
      delegate { id }
      labels { nodes { name } }
    }
    pageInfo { hasNextPage endCursor }
  }
  comments(
    first: 50
    after: $commentAfter
    orderBy: updatedAt
    filter: { updatedAt: { gt: $since }, issue: { team: $team } }
  ) @include(if: $includeComments) {
    nodes {
      id
      body
      updatedAt
      issue { id }
    }
    pageInfo { hasNextPage endCursor }
  }
  agentActivities(
    first: 50
    after: $activityAfter
    orderBy: updatedAt
    filter: { updatedAt: { gt: $since }, type: { eq: "prompt" } }
  ) @include(if: $includeActivities) {
    nodes {
      id
      createdAt
      user { id }
      updatedAt
      signal
      agentSession { id issue { id } }
      content { __typename ... on AgentActivityPromptContent { body type } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

export type PolledIssue = {
  id: string;
  identifier: string | null;
  updatedAtMs: number;
  labeled: boolean;
  delegated: boolean;
};

export type PolledComment = {
  id: string;
  issueId: string | null;
  body: string;
  updatedAtMs: number;
};

export type PolledSession = {
  id: string;
  issueId: string;
  createdAtMs: number;
  updatedAtMs: number;
  endedAtMs?: number | null;
  stoppedAtMs?: number | null;
};

export type PolledActivity = {
  id: string;
  actorId?: string | null;
  activityCreatedAtMs?: number | null;
  issueId: string | null;
  sessionId: string | null;
  body: string | null;
  signal: string | null;
  updatedAtMs: number;
};

export type IntakeSighting = {
  sessions: readonly PolledSession[];
  issues: readonly PolledIssue[];
  comments: readonly PolledComment[];
  activities: readonly PolledActivity[];
  budget: LinearRateBudget | null;
  /** False while a connection still has another page. The time cursor stays put. */
  caughtUp: boolean;
  /** False when no team is configured, so the tick does not touch the network or the cursor. */
  queried: boolean;
};

export type IntakePollSource = {
  poll(sinceMs: number): Promise<IntakeSighting>;
};

/** Poll team issues, comments, and agent activities with one query per call. */
export function createIntakePollSource(
  client: LinearClient,
  options: { teamId: string | null; appUserId?: string | null },
): IntakePollSource {
  let issueAfter: string | null = null;
  let commentAfter: string | null = null;
  let activityAfter: string | null = null;
  let sessionAfter: string | null = null;
  let cycleSince: string | null = null;
  const finished = new Set<string>();
  const latestSessions = new Map<string, PolledSession>();
  let viewerId: string | null = options.appUserId ?? null;

  return {
    async poll(sinceMs) {
      const teamId = options.teamId === "" ? null : options.teamId;
      cycleSince ??= new Date(sinceMs).toISOString();
      const data = await client.query(INTAKE_QUERY, {
        team:
          teamId === null
            ? {}
            : /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(teamId)
              ? { id: { eq: teamId } }
              : { key: { eq: teamId } },
        since: cycleSince,
        issueAfter,
        commentAfter,
        activityAfter,
        sessionAfter,
        includeIssues: !finished.has("issues"),
        includeComments: !finished.has("comments"),
        includeActivities: !finished.has("activities"),
        includeSessions: !finished.has("sessions"),
      });
      const root = isRecord(data) ? data : {};
      const seenViewer = readViewerId(root);
      if (seenViewer !== null) viewerId = seenViewer;
      const appUserId = viewerId ?? options.appUserId ?? null;
      const issues = readConnection(root, "issues");
      const comments = readConnection(root, "comments");
      const activities = readConnection(root, "agentActivities");
      const sessions = readConnection(root, "agentSessions");
      for (const [name, connection, cursor] of [
        ["issues", issues, issueAfter],
        ["comments", comments, commentAfter],
        ["activities", activities, activityAfter],
        ["sessions", sessions, sessionAfter],
      ] as const) {
        if (finished.has(name) || !connection.hasNextPage) continue;
        if (connection.endCursor === null || connection.endCursor === cursor) {
          throw new Error(`Linear ${name} pagination did not advance`);
        }
      }
      const pendingIssues = finished.has("issues") ? [] : issues.nodes;
      const pendingComments = finished.has("comments") ? [] : comments.nodes;
      const pendingActivities = finished.has("activities") ? [] : activities.nodes;
      if (!finished.has("sessions")) {
        for (const session of readSessions(root, appUserId, teamId)) {
          const prior = latestSessions.get(session.id);
          if (prior === undefined || session.updatedAtMs > prior.updatedAtMs) {
            latestSessions.set(session.id, session);
          }
        }
      }
      const issuesCaughtUp =
        finished.has("issues") ||
        advance(
          issues,
          () => issueAfter,
          (cursor) => {
            issueAfter = cursor;
          },
        );
      const commentsCaughtUp =
        finished.has("comments") ||
        advance(
          comments,
          () => commentAfter,
          (cursor) => {
            commentAfter = cursor;
          },
        );
      const activitiesCaughtUp =
        finished.has("activities") ||
        advance(
          activities,
          () => activityAfter,
          (cursor) => {
            activityAfter = cursor;
          },
        );
      const cycleSinceMs = Date.parse(cycleSince);
      const sessionsCaughtUp =
        finished.has("sessions") ||
        sessions.nodes.some(
          (node) => (readTime(node, "updatedAt") ?? cycleSinceMs) < cycleSinceMs,
        ) ||
        advance(
          sessions,
          () => sessionAfter,
          (cursor) => {
            sessionAfter = cursor;
          },
        );
      if (issuesCaughtUp) finished.add("issues");
      if (commentsCaughtUp) finished.add("comments");
      if (activitiesCaughtUp) finished.add("activities");
      if (sessionsCaughtUp) finished.add("sessions");
      const discoveredSessions = sessionsCaughtUp ? [...latestSessions.values()] : [];
      const caughtUp = issuesCaughtUp && commentsCaughtUp && activitiesCaughtUp && sessionsCaughtUp;
      if (caughtUp) {
        issueAfter = null;
        commentAfter = null;
        activityAfter = null;
        sessionAfter = null;
        cycleSince = null;
        finished.clear();
        latestSessions.clear();
      }
      return {
        sessions: discoveredSessions,
        issues: dedupeIssues(pendingIssues, appUserId),
        comments: dedupeComments(pendingComments),
        activities: dedupeActivities(pendingActivities),
        budget: linearBudget(client),
        caughtUp,
        queried: true,
      };
    },
  };
}

function readSessions(
  root: Record<string, unknown>,
  appUserId: string | null,
  teamId: string | null,
): PolledSession[] {
  const latest = new Map<string, PolledSession>();
  for (const node of readConnection(root, "agentSessions").nodes) {
    const user = isRecord(node["appUser"]) ? node["appUser"] : null;
    const issue = isRecord(node["issue"]) ? node["issue"] : null;
    const team = issue !== null && isRecord(issue["team"]) ? issue["team"] : null;
    if (user === null || readString(user, "id") !== appUserId || issue === null || team === null)
      continue;
    if (teamId !== null && readString(team, "id") !== teamId && readString(team, "key") !== teamId)
      continue;
    const id = readString(node, "id");
    const issueId = readString(issue, "id");
    const createdAtMs = readTime(node, "createdAt");
    const updatedAtMs = readTime(node, "updatedAt");
    if (id === null || issueId === null || createdAtMs === null || updatedAtMs === null) continue;
    const prior = latest.get(id);
    if (prior === undefined || updatedAtMs > prior.updatedAtMs) {
      latest.set(id, {
        id,
        issueId,
        createdAtMs,
        updatedAtMs,
        endedAtMs: readTime(node, "endedAt"),
        stoppedAtMs:
          readTime(node, "dismissedAt") ??
          readTime(node, "archivedAt") ??
          (readString(node, "status") === "stopping" ? updatedAtMs : null),
      });
    }
  }
  return [...latest.values()];
}

function advance(
  connection: Connection,
  current: () => string | null,
  set: (cursor: string | null) => void,
): boolean {
  if (!connection.hasNextPage || connection.endCursor === null) {
    set(null);
    return true;
  }
  if (connection.endCursor === current()) {
    set(null);
    return true;
  }
  set(connection.endCursor);
  return false;
}

function dedupeIssues(
  nodes: readonly Record<string, unknown>[],
  appUserId: string | null,
): PolledIssue[] {
  const seen = new Set<string>();
  const issues: PolledIssue[] = [];
  for (const node of nodes) {
    const id = readString(node, "id");
    const updatedAtMs = readTime(node, "updatedAt");
    if (id === null || updatedAtMs === null || seen.has(id)) continue;
    seen.add(id);
    const delegate = isRecord(node["delegate"]) ? node["delegate"] : null;
    const delegateId = delegate === null ? null : readString(delegate, "id");
    issues.push({
      id,
      identifier: readString(node, "identifier"),
      updatedAtMs,
      labeled: hasPawsLabel(node),
      delegated: appUserId !== null && delegateId === appUserId,
    });
  }
  return issues;
}

function dedupeComments(nodes: readonly Record<string, unknown>[]): PolledComment[] {
  const seen = new Set<string>();
  const comments: PolledComment[] = [];
  for (const node of nodes) {
    const id = readString(node, "id");
    const body = readString(node, "body");
    const updatedAtMs = readTime(node, "updatedAt");
    if (id === null || body === null || updatedAtMs === null || seen.has(id)) continue;
    seen.add(id);
    const issue = isRecord(node["issue"]) ? node["issue"] : null;
    comments.push({
      id,
      issueId: issue === null ? null : readString(issue, "id"),
      body,
      updatedAtMs,
    });
  }
  return comments;
}

function dedupeActivities(nodes: readonly Record<string, unknown>[]): PolledActivity[] {
  const seen = new Set<string>();
  const activities: PolledActivity[] = [];
  for (const node of nodes) {
    const id = readString(node, "id");
    const updatedAtMs = readTime(node, "updatedAt");
    if (id === null || updatedAtMs === null || seen.has(id)) continue;
    seen.add(id);
    const content = isRecord(node["content"]) ? node["content"] : null;
    if (content === null || readString(content, "type") !== "prompt") continue;
    const session = isRecord(node["agentSession"]) ? node["agentSession"] : null;
    const issue = session !== null && isRecord(session["issue"]) ? session["issue"] : null;
    const user = isRecord(node["user"]) ? node["user"] : null;
    activities.push({
      id,
      actorId: user === null ? null : readString(user, "id"),
      activityCreatedAtMs: readTime(node, "createdAt"),
      issueId: issue === null ? null : readString(issue, "id"),
      sessionId: session === null ? null : readString(session, "id"),
      body: content === null ? null : readString(content, "body"),
      signal: readString(node, "signal"),
      updatedAtMs,
    });
  }
  return activities;
}

function hasPawsLabel(issue: Record<string, unknown>): boolean {
  const labels = issue["labels"];
  const nodes =
    isRecord(labels) && Array.isArray(labels["nodes"])
      ? labels["nodes"]
      : Array.isArray(labels)
        ? labels
        : [];
  return nodes.some(
    (node) => isRecord(node) && (readString(node, "name") ?? "").toLowerCase() === "paws",
  );
}

function readViewerId(root: Record<string, unknown>): string | null {
  const viewer = root["viewer"];
  return isRecord(viewer) ? readString(viewer, "id") : null;
}

function readTime(node: Record<string, unknown>, key: string): number | null {
  const value = readString(node, key);
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

type Connection = {
  nodes: Record<string, unknown>[];
  hasNextPage: boolean;
  endCursor: string | null;
};

function readConnection(data: Record<string, unknown>, key: string): Connection {
  const connection = data[key];
  if (!isRecord(connection)) return { nodes: [], hasNextPage: false, endCursor: null };
  const nodes = Array.isArray(connection["nodes"]) ? connection["nodes"].filter(isRecord) : [];
  const pageInfo = isRecord(connection["pageInfo"]) ? connection["pageInfo"] : null;
  return {
    nodes,
    hasNextPage: pageInfo?.["hasNextPage"] === true,
    endCursor: pageInfo === null ? null : readString(pageInfo, "endCursor"),
  };
}
