import { LinearHttpError } from "../linear";
import type { CommentBoard, CommentWrite, IssueComment } from "./board";

const GRAPHQL_URL = "https://api.linear.app/graphql";

const CREATE_COMMENT = `mutation CommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id body createdAt parentId user { id } botActor { id } }
  }
}`;

const UPDATE_COMMENT = `mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) {
    success
    comment { id body createdAt parentId user { id } botActor { id } }
  }
}`;

const ISSUE_COMMENTS = `query IssueComments($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: 50, after: $after) {
      nodes { id body createdAt parentId user { id } botActor { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const COMMENT_CHILDREN = `query CommentChildren($id: String!, $after: String) {
  comment(id: $id) {
    children(first: 50, after: $after) {
      nodes { id body createdAt parentId user { id } botActor { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

const VIEWER = `query Viewer { viewer { id } }`;

export type CommentQuery = {
  query(query: string, variables?: Record<string, unknown>): Promise<unknown>;
};

export type CommentFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * GraphQL client for a Linear personal API key.
 * Linear's personal-key header is the raw key, not a Bearer token.
 */
export function createPersonalLinearClient(options: {
  apiKey: string;
  fetch?: CommentFetch;
}): CommentQuery {
  const apiKey = options.apiKey.trim();
  if (apiKey.length === 0) throw new Error("Linear personal API key is empty");
  const fetchImpl = options.fetch ?? fetch;
  return {
    async query(query, variables) {
      const response = await fetchImpl(GRAPHQL_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: apiKey,
        },
        body: JSON.stringify({ query, variables: variables ?? {} }),
      });
      if (!response.ok)
        throw new LinearHttpError(response.status, "", response.headers.get("retry-after"));
      const json: unknown = await response.json();
      if (!isRecord(json)) throw new Error("Linear GraphQL returned no data");
      const errors = json["errors"];
      if (Array.isArray(errors) && errors.length > 0) {
        const first = errors[0];
        const message =
          isRecord(first) && typeof first["message"] === "string"
            ? first["message"]
            : "request failed";
        throw new Error(`Linear GraphQL: ${message}`);
      }
      if (json["data"] === undefined) throw new Error("Linear GraphQL returned no data");
      return json["data"];
    },
  };
}

export async function fetchLinearViewerId(client: CommentQuery): Promise<string> {
  const data = await client.query(VIEWER);
  const viewer = dig(data, ["viewer"]);
  const id = viewer === null ? null : readString(viewer, "id");
  if (id === null) throw new Error("Linear viewer id was missing");
  return id;
}

/** `commentCreate` / `commentUpdate` / issue comment list. No agent-session mutations. */
export function createLinearCommentBoard(client: CommentQuery): CommentBoard {
  return {
    async create(input: CommentWrite) {
      const data = await client.query(CREATE_COMMENT, {
        input: {
          issueId: input.issueId,
          body: input.body,
          ...(input.parentId === null ? {} : { parentId: input.parentId }),
        },
      });
      const payload = dig(data, ["commentCreate"]);
      if (payload?.["success"] === false) throw new Error("Linear commentCreate failed");
      const comment = readComment(payload?.["comment"], input.issueId, 0);
      if (comment === null) throw new Error("Linear commentCreate returned no comment");
      if (comment.parentId === null) comment.parentId = input.parentId;
      if (comment.issueId.length === 0) comment.issueId = input.issueId;
      return comment;
    },
    async update(input) {
      const data = await client.query(UPDATE_COMMENT, {
        id: input.id,
        input: { body: input.body },
      });
      const payload = dig(data, ["commentUpdate"]);
      if (payload?.["success"] === false) throw new Error("Linear commentUpdate failed");
      const comment = readComment(payload?.["comment"], "", 0);
      if (comment === null) throw new Error("Linear commentUpdate returned no comment");
      comment.body = input.body;
      return comment;
    },
    async list(issueId) {
      const found = new Map<string, IssueComment>();
      let seq = 1;
      let after: string | null = null;
      const roots: IssueComment[] = [];
      for (let page = 0; page < 20; page++) {
        const data = await client.query(ISSUE_COMMENTS, { id: issueId, after });
        const issue = dig(data, ["issue"]);
        const connection = readConnection(issue?.["comments"]);
        for (const node of connection.nodes) {
          const comment = readComment(node, issueId, seq);
          if (comment === null || found.has(comment.id)) continue;
          seq += 1;
          found.set(comment.id, comment);
          if (comment.parentId === null) roots.push(comment);
        }
        if (!connection.hasNextPage || connection.endCursor === null) break;
        after = connection.endCursor;
      }
      for (const root of roots) {
        let childAfter: string | null = null;
        for (let page = 0; page < 10; page++) {
          const data = await client.query(COMMENT_CHILDREN, { id: root.id, after: childAfter });
          const parent = dig(data, ["comment"]);
          const connection = readConnection(parent?.["children"]);
          for (const node of connection.nodes) {
            const comment = readComment(node, issueId, seq);
            if (comment === null || found.has(comment.id)) continue;
            if (comment.parentId === null) comment.parentId = root.id;
            seq += 1;
            found.set(comment.id, comment);
          }
          if (!connection.hasNextPage || connection.endCursor === null) break;
          childAfter = connection.endCursor;
        }
      }
      return [...found.values()].sort(compareComments);
    },
  };
}

function compareComments(left: IssueComment, right: IssueComment): number {
  if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs;
  if (left.seq !== right.seq) return left.seq - right.seq;
  return left.id.localeCompare(right.id);
}

function readComment(value: unknown, issueId: string, seq: number): IssueComment | null {
  if (!isRecord(value)) return null;
  const id = readString(value, "id");
  if (id === null) return null;
  const createdAt = readString(value, "createdAt");
  const createdAtMs = createdAt === null ? 0 : Date.parse(createdAt);
  const user = isRecord(value["user"]) ? value["user"] : null;
  const bot = isRecord(value["botActor"]) ? value["botActor"] : null;
  return {
    id,
    issueId,
    parentId: readString(value, "parentId"),
    body: typeof value["body"] === "string" ? value["body"] : "",
    userId: user === null ? null : readString(user, "id"),
    botId: bot === null ? null : readString(bot, "id"),
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    seq,
  };
}

function readConnection(value: unknown): {
  nodes: Record<string, unknown>[];
  hasNextPage: boolean;
  endCursor: string | null;
} {
  if (!isRecord(value)) return { nodes: [], hasNextPage: false, endCursor: null };
  const nodes = Array.isArray(value["nodes"]) ? value["nodes"].filter(isRecord) : [];
  const pageInfo = isRecord(value["pageInfo"]) ? value["pageInfo"] : null;
  return {
    nodes,
    hasNextPage: pageInfo?.["hasNextPage"] === true,
    endCursor: pageInfo === null ? null : readString(pageInfo, "endCursor"),
  };
}

function dig(value: unknown, path: readonly string[]): Record<string, unknown> | null {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return isRecord(current) ? current : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
