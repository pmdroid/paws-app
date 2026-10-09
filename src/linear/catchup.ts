import { activityKey, sessionCreatedKey, type AcceptedLinearEvent } from "./events";
import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";

const SESSIONS_QUERY = `query CatchUpSessions($first: Int, $last: Int, $after: String, $before: String) {
  agentSessions(first: $first, last: $last, after: $after, before: $before, orderBy: updatedAt) {
    nodes { id createdAt updatedAt issue { id } }
    pageInfo { hasNextPage hasPreviousPage endCursor startCursor }
  }
}`;

const ACTIVITIES_QUERY = `query CatchUpActivities($since: DateTimeOrDuration!, $after: String) {
  agentActivities(first: 50, after: $after, orderBy: updatedAt, filter: { updatedAt: { gt: $since } }) {
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

export type CatchUpSource = {
  listUpdated(sinceMs: number): Promise<readonly AcceptedLinearEvent[]>;
};

/** Poll `agentSessions` and prompt `agentActivities` updated since the cursor. */
export function createLinearCatchUpSource(client: LinearClient): CatchUpSource {
  return {
    async listUpdated(sinceMs) {
      const events: AcceptedLinearEvent[] = [];
      const sessions = await listSessions(client, sinceMs);
      for (const session of sessions) {
        if (session.createdAtMs <= sinceMs) continue;
        events.push({
          dedupeKey: sessionCreatedKey(session.id),
          deliveryId: null,
          source: "poll",
          action: "created",
          sessionId: session.id,
          issueId: session.issueId,
          activityId: null,
          body: null,
          signal: null,
          updatedAtMs: session.createdAtMs,
          payload: JSON.stringify({ sessionId: session.id, issueId: session.issueId }),
        });
      }
      const activities = await listPromptActivities(client, sinceMs);
      for (const activity of activities) {
        events.push({
          dedupeKey: activityKey(activity.id),
          deliveryId: null,
          source: "poll",
          action: "prompted",
          sessionId: activity.sessionId,
          issueId: activity.issueId,
          activityId: activity.id,
          body: activity.body,
          signal: activity.signal,
          updatedAtMs: activity.updatedAtMs,
          payload: JSON.stringify({
            activityId: activity.id,
            sessionId: activity.sessionId,
            body: activity.body,
            signal: activity.signal,
          }),
        });
      }
      events.sort((left, right) => left.updatedAtMs - right.updatedAtMs);
      return events;
    },
  };
}

type SessionRow = { id: string; createdAtMs: number; updatedAtMs: number; issueId: string | null };

async function listSessions(client: LinearClient, sinceMs: number): Promise<SessionRow[]> {
  const found: SessionRow[] = [];
  let after: string | null = null;
  for (let page = 0; page < 20; page++) {
    const data = await client.query(SESSIONS_QUERY, { first: 50, last: null, after, before: null });
    const connection = readConnection(data, "agentSessions");
    if (connection.nodes.length === 0) break;
    const rows = connection.nodes
      .map(parseSession)
      .filter((row): row is SessionRow => row !== null);
    const times = rows.map((row) => row.updatedAtMs);
    const min = Math.min(...times);
    const max = Math.max(...times);
    found.push(...rows.filter((row) => row.createdAtMs > sinceMs || row.updatedAtMs > sinceMs));
    if (!connection.hasNextPage || connection.endCursor === null) break;
    const ascending =
      times[0] !== undefined &&
      times[times.length - 1] !== undefined &&
      times[0] <= (times[times.length - 1] ?? times[0]);
    if (!ascending && min <= sinceMs) break;
    if (ascending && max <= sinceMs) {
      after = connection.endCursor;
      continue;
    }
    if (!ascending) break;
    after = connection.endCursor;
  }
  return found;
}

type ActivityRow = {
  id: string;
  updatedAtMs: number;
  sessionId: string | null;
  issueId: string | null;
  body: string | null;
  signal: string | null;
};

async function listPromptActivities(client: LinearClient, sinceMs: number): Promise<ActivityRow[]> {
  const found: ActivityRow[] = [];
  let after: string | null = null;
  const since = new Date(sinceMs).toISOString();
  for (let page = 0; page < 20; page++) {
    const data = await client.query(ACTIVITIES_QUERY, { since, after });
    const connection = readConnection(data, "agentActivities");
    for (const node of connection.nodes) {
      const content = isRecord(node["content"]) ? node["content"] : null;
      const typename = content === null ? null : readString(content, "__typename");
      const type = content === null ? null : readString(content, "type");
      if (typename !== "AgentActivityPromptContent" && type !== "prompt") continue;
      const id = readString(node, "id");
      const updatedAt = readString(node, "updatedAt");
      if (id === null || updatedAt === null) continue;
      const updatedAtMs = Date.parse(updatedAt);
      if (!Number.isFinite(updatedAtMs) || updatedAtMs <= sinceMs) continue;
      const session = isRecord(node["agentSession"]) ? node["agentSession"] : null;
      const issue = session !== null && isRecord(session["issue"]) ? session["issue"] : null;
      found.push({
        id,
        updatedAtMs,
        sessionId: session === null ? null : readString(session, "id"),
        issueId: issue === null ? null : readString(issue, "id"),
        body: content === null ? null : readString(content, "body"),
        signal: readString(node, "signal"),
      });
    }
    if (!connection.hasNextPage || connection.endCursor === null) break;
    after = connection.endCursor;
  }
  return found;
}

function parseSession(node: Record<string, unknown>): SessionRow | null {
  const id = readString(node, "id");
  const createdAt = readString(node, "createdAt");
  const updatedAt = readString(node, "updatedAt");
  if (id === null || createdAt === null || updatedAt === null) return null;
  const createdAtMs = Date.parse(createdAt);
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(updatedAtMs)) return null;
  const issue = isRecord(node["issue"]) ? node["issue"] : null;
  return { id, createdAtMs, updatedAtMs, issueId: issue === null ? null : readString(issue, "id") };
}

function readConnection(
  data: unknown,
  key: string,
): {
  nodes: Record<string, unknown>[];
  hasNextPage: boolean;
  endCursor: string | null;
} {
  if (!isRecord(data)) return { nodes: [], hasNextPage: false, endCursor: null };
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
