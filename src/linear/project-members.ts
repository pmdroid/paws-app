import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";

const QUERY = `query RunnerProjectMembers($id: String!, $after: String) {
  project(id: $id) {
    id
    members(first: 50, after: $after) {
      nodes { id }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export function createLinearProjectMembers(client: LinearClient) {
  return {
    async listProjectMembers(
      id: string,
      options?: TrackerRequestOptions,
    ): Promise<readonly string[]> {
      if (!id.trim()) throw new Error("Linear project is required.");
      let after: string | null = null;
      const cursors = new Set<string>();
      const members = new Set<string>();
      for (let page = 0; page < 1000; page++) {
        options?.signal?.throwIfAborted();
        const data = await client.query(QUERY, { id, after }, options);
        options?.signal?.throwIfAborted();
        const project = isRecord(data) ? data["project"] : null;
        const connection = isRecord(project) ? project["members"] : null;
        if (
          !isRecord(project) ||
          project["id"] !== id ||
          !isRecord(connection) ||
          !Array.isArray(connection["nodes"])
        )
          throw new Error("Linear returned incomplete project membership.");
        for (const node of connection["nodes"]) {
          const member = isRecord(node) ? readString(node, "id") : null;
          if (!member?.trim()) throw new Error("Linear returned incomplete project membership.");
          members.add(member);
        }
        const info = connection["pageInfo"];
        if (!isRecord(info)) throw new Error("Linear returned incomplete project pagination.");
        if (info["hasNextPage"] === false) return [...members].sort();
        const cursor = readString(info, "endCursor");
        if (info["hasNextPage"] !== true || !cursor || cursors.has(cursor))
          throw new Error("Linear project pagination did not advance.");
        cursors.add(cursor);
        after = cursor;
      }
      throw new Error("Linear project pagination exceeded its limit.");
    },
  };
}
