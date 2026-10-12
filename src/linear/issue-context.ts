import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";

export type LinearIssueContext = {
  id: string;
  teamId: string;
  issue: Record<string, unknown>;
  comments: readonly Record<string, unknown>[];
};

const QUERY = `query PawsIssueContext($id: String!, $after: String) {
  issue(id: $id) {
    id identifier title description updatedAt
    team { id } state { id name type } assignee { id name } delegate { id name }
    reactions { id emoji createdAt user { id name } }
    comments(first: 50, after: $after, orderBy: createdAt, includeArchived: true) {
      nodes {
        id body createdAt updatedAt parent { id } user { id name }
        reactions { id emoji createdAt user { id name } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export function createLinearIssueContextReads(client: LinearClient) {
  return {
    async getIssueContext(
      id: string,
      options?: TrackerRequestOptions,
    ): Promise<LinearIssueContext> {
      const comments = new Map<string, Record<string, unknown>>();
      const cursors = new Set<string>();
      let after: string | null = null;
      let snapshot: LinearIssueContext | null = null;
      for (;;) {
        options?.signal?.throwIfAborted();
        const data = await client.query(QUERY, { id, after }, options);
        options?.signal?.throwIfAborted();
        const issue = isRecord(data) ? data["issue"] : null;
        const team = isRecord(issue) ? issue["team"] : null;
        if (!isRecord(issue) || issue["id"] !== id || !isRecord(team) || !readString(team, "id"))
          throw new Error("Linear returned another issue during context refresh.");
        if (snapshot === null) {
          const { comments: _comments, team: _team, ...details } = issue;
          snapshot = { id, teamId: readString(team, "id")!, issue: details, comments: [] };
        }
        const connection = issue["comments"];
        if (
          !isRecord(connection) ||
          !Array.isArray(connection["nodes"]) ||
          !isRecord(connection["pageInfo"])
        )
          throw new Error("Linear issue context has no comments connection.");
        for (const comment of connection["nodes"]) {
          if (
            !isRecord(comment) ||
            !readString(comment, "id") ||
            typeof comment["body"] !== "string"
          )
            throw new Error("Linear returned an invalid issue comment.");
          comments.set(readString(comment, "id")!, comment);
        }
        const page = connection["pageInfo"];
        if (page["hasNextPage"] === false) return { ...snapshot, comments: [...comments.values()] };
        const cursor = readString(page, "endCursor");
        if (page["hasNextPage"] !== true || cursor === null || cursors.has(cursor))
          throw new Error("Linear issue comment pagination did not advance.");
        cursors.add(cursor);
        after = cursor;
      }
    },
  };
}
