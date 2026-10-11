import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";
import type { ActionDetails, SessionUrl } from "./types";

export type LinearSessionStatus =
  | "pending"
  | "active"
  | "stopping"
  | "awaitingInput"
  | "complete"
  | "error"
  | "stale"
  | (string & {});
export type LinearActivityContent =
  | { type: "thought" | "prompt" | "response" | "error" | "elicitation"; body: string }
  | ({ type: "action" } & ActionDetails);
export type LinearActivitySnapshot = {
  id: string;
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  userId: string;
  content: LinearActivityContent;
  signal: string | null;
  signalMetadata: unknown;
  sourceCommentId: string | null;
  ephemeral: boolean;
};
export type LinearSessionSnapshot = {
  id: string;
  status: LinearSessionStatus;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  dismissedAt: string | null;
  appUserId: string;
  creatorId: string | null;
  issue: { id: string; identifier: string; title: string; description: string | null } | null;
  comment: { id: string; body: string; createdAt: string } | null;
  sourceComment: { id: string; body: string; createdAt: string } | null;
  summary: string | null;
  plan: unknown;
  context: unknown;
  externalLinks: readonly SessionUrl[];
  pullRequest: { id: string; url: string } | null;
};

const SESSION_QUERY = `query PawsAgentSession($id: String!) {
  agentSession(id: $id) {
    id status createdAt updatedAt endedAt dismissedAt summary plan context
    appUser { id } creator { id }
    issue { id identifier title description }
    comment { id body createdAt } sourceComment { id body createdAt }
    externalLinks { label url } pullRequest { id url }
  }
}`;
const HISTORY_QUERY = `query PawsAgentSessionHistory($id: String!, $after: String) {
  agentSession(id: $id) {
    id activities(first: 50, after: $after, orderBy: createdAt, includeArchived: true) {
      nodes {
        id createdAt updatedAt ephemeral signal signalMetadata user { id } sourceComment { id }
        content {
          __typename
          ... on AgentActivityThoughtContent { type body }
          ... on AgentActivityPromptContent { type body }
          ... on AgentActivityResponseContent { type body }
          ... on AgentActivityErrorContent { type body }
          ... on AgentActivityElicitationContent { type body }
          ... on AgentActivityActionContent { type action parameter result }
        }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export function createLinearSessionReads(client: LinearClient) {
  return {
    async getSession(id: string, options?: TrackerRequestOptions): Promise<LinearSessionSnapshot> {
      const data = await client.query(SESSION_QUERY, { id }, options);
      options?.signal?.throwIfAborted();
      const session = rootSession(data, id);
      const status = required(session, "status");
      const issue = session["issue"];
      const pullRequest = session["pullRequest"];
      if (!Array.isArray(session["externalLinks"]))
        throw new Error("Missing Linear session externalLinks");
      return {
        id,
        status: status as LinearSessionStatus,
        createdAt: required(session, "createdAt"),
        updatedAt: required(session, "updatedAt"),
        endedAt: readString(session, "endedAt"),
        dismissedAt: readString(session, "dismissedAt"),
        appUserId: relatedId(session, "appUser") ?? fail("appUser"),
        creatorId: relatedId(session, "creator"),
        issue: isRecord(issue)
          ? {
              id: required(issue, "id"),
              identifier: required(issue, "identifier"),
              title: required(issue, "title"),
              description: readString(issue, "description"),
            }
          : null,
        comment: readComment(session["comment"]),
        sourceComment: readComment(session["sourceComment"]),
        summary: readString(session, "summary"),
        plan: session["plan"] ?? null,
        context: session["context"] ?? null,
        externalLinks: session["externalLinks"].map((entry: unknown) => {
          if (!isRecord(entry)) return fail("externalLink");
          return { label: required(entry, "label"), url: required(entry, "url") };
        }),
        pullRequest: isRecord(pullRequest)
          ? { id: required(pullRequest, "id"), url: required(pullRequest, "url") }
          : null,
      };
    },
    async listSessionActivities(
      id: string,
      options?: TrackerRequestOptions,
    ): Promise<readonly LinearActivitySnapshot[]> {
      const snapshots = new Map<string, LinearActivitySnapshot>();
      const cursors = new Set<string>();
      let after: string | null = null;
      for (;;) {
        options?.signal?.throwIfAborted();
        const session = rootSession(await client.query(HISTORY_QUERY, { id, after }, options), id);
        options?.signal?.throwIfAborted();
        const connection = session["activities"];
        if (
          !isRecord(connection) ||
          !Array.isArray(connection["nodes"]) ||
          !isRecord(connection["pageInfo"])
        )
          return fail("activities connection");
        for (const node of connection["nodes"]) {
          if (!isRecord(node)) return fail("activity");
          const activityId = required(node, "id");
          if (snapshots.has(activityId)) continue;
          snapshots.set(activityId, {
            id: activityId,
            sessionId: id,
            createdAt: required(node, "createdAt"),
            updatedAt: required(node, "updatedAt"),
            userId: relatedId(node, "user") ?? fail("activity user"),
            content: readContent(node["content"]),
            signal: readString(node, "signal"),
            signalMetadata: node["signalMetadata"] ?? null,
            sourceCommentId: relatedId(node, "sourceComment"),
            ephemeral: node["ephemeral"] === true,
          });
        }
        const pageInfo = connection["pageInfo"];
        if (pageInfo["hasNextPage"] === false) break;
        if (pageInfo["hasNextPage"] !== true) return fail("activity pagination");
        const cursor = readString(pageInfo, "endCursor");
        if (cursor === null || cursors.has(cursor))
          throw new Error("Linear activity history pagination did not advance");
        cursors.add(cursor);
        after = cursor;
      }
      return [...snapshots.values()].sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
    },
  };
}

function readContent(value: unknown): LinearActivityContent {
  if (!isRecord(value)) return fail("activity content");
  const type = required(value, "type");
  if (type === "action")
    return {
      type,
      action: required(value, "action"),
      parameter: required(value, "parameter"),
      ...(typeof value["result"] === "string" ? { result: value["result"] } : {}),
    };
  if (
    ["thought", "prompt", "response", "error", "elicitation"].includes(type) &&
    typeof value["body"] === "string"
  )
    return { type: type as Exclude<LinearActivityContent["type"], "action">, body: value["body"] };
  return fail("activity content type");
}

function rootSession(data: unknown, id: string): Record<string, unknown> {
  const session = isRecord(data) ? data["agentSession"] : null;
  if (!isRecord(session) || readString(session, "id") !== id)
    throw new Error(`Linear session ${id} was not found`);
  return session;
}
function relatedId(record: Record<string, unknown>, key: string): string | null {
  const related = record[key];
  return isRecord(related) ? readString(related, "id") : null;
}
function readComment(value: unknown): LinearSessionSnapshot["comment"] {
  return isRecord(value)
    ? {
        id: required(value, "id"),
        body: typeof value["body"] === "string" ? value["body"] : fail("comment body"),
        createdAt: required(value, "createdAt"),
      }
    : null;
}
function required(record: Record<string, unknown>, key: string): string {
  return readString(record, key) ?? fail(key);
}
function fail(field: string): never {
  throw new Error(`Missing or invalid Linear ${field}`);
}
