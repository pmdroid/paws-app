import { linearBudget, type LinearRateBudget } from "./budget";
import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";

/**
 * One GraphQL document per tick: team issues updated after the cursor,
 * plus comments and agent activities updated after the same cursor.
 */
const INTAKE_QUERY = `query IntakePoll($team: String!, $since: DateTimeOrDuration!, $issueAfter: String, $commentAfter: String, $activityAfter: String) {
  viewer { id }
  issues(
    first: 50
    after: $issueAfter
    orderBy: updatedAt
    filter: { updatedAt: { gt: $since }, team: { or: [{ id: { eq: $team } }, { key: { eq: $team } }] } }
  ) {
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
    filter: { updatedAt: { gt: $since }, issue: { team: { or: [{ id: { eq: $team } }, { key: { eq: $team } }] } } }
  ) {
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
    filter: { updatedAt: { gt: $since } }
  ) {
    nodes {
      id
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

export type PolledActivity = {
  id: string;
  issueId: string | null;
  sessionId: string | null;
  body: string | null;
  signal: string | null;
  updatedAtMs: number;
};

export type IntakeSighting = {
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

const EMPTY: IntakeSighting = {
  issues: [],
  comments: [],
  activities: [],
  budget: null,
  caughtUp: true,
  queried: false,
};

/** Poll team issues, comments, and agent activities with one query per call. */
export function createIntakePollSource(
  client: LinearClient,
  options: { teamId: string | null; appUserId?: string | null },
): IntakePollSource {
  let issueAfter: string | null = null;
  let commentAfter: string | null = null;
  let activityAfter: string | null = null;
  let viewerId: string | null = options.appUserId ?? null;

  return {
    async poll(sinceMs) {
      const teamId = options.teamId;
      if (teamId === null || teamId.length === 0) return EMPTY;
      const data = await client.query(INTAKE_QUERY, {
        team: teamId,
        since: new Date(sinceMs).toISOString(),
        issueAfter,
        commentAfter,
        activityAfter,
      });
      const root = isRecord(data) ? data : {};
      const seenViewer = readViewerId(root);
      if (seenViewer !== null) viewerId = seenViewer;
      const appUserId = viewerId ?? options.appUserId ?? null;
      const issues = readConnection(root, "issues");
      const comments = readConnection(root, "comments");
      const activities = readConnection(root, "agentActivities");
      const issuesCaughtUp = advance(
        issues,
        () => issueAfter,
        (cursor) => {
          issueAfter = cursor;
        },
      );
      const commentsCaughtUp = advance(
        comments,
        () => commentAfter,
        (cursor) => {
          commentAfter = cursor;
        },
      );
      const activitiesCaughtUp = advance(
        activities,
        () => activityAfter,
        (cursor) => {
          activityAfter = cursor;
        },
      );
      const caughtUp = issuesCaughtUp && commentsCaughtUp && activitiesCaughtUp;
      if (caughtUp) {
        issueAfter = null;
        commentAfter = null;
        activityAfter = null;
      }
      return {
        issues: dedupeIssues(issues.nodes, appUserId),
        comments: dedupeComments(comments.nodes),
        activities: dedupeActivities(activities.nodes),
        budget: linearBudget(client),
        caughtUp,
        queried: true,
      };
    },
  };
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
    const session = isRecord(node["agentSession"]) ? node["agentSession"] : null;
    const issue = session !== null && isRecord(session["issue"]) ? session["issue"] : null;
    activities.push({
      id,
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
