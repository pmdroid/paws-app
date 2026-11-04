import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";

export type LinearLinkableIssue = {
  id: string;
  identifier: string;
  url: string | null;
  teamId: string;
  state: "open" | "closed";
};

const QUERY = `query PawsImprovementIssue($id: String!) {
  issue(id: $id) { id identifier url team { id } state { type } }
}`;

const CLOSED = new Set(["completed", "canceled"]);

export function createLinearImprovementIssueLookup(client: LinearClient) {
  return async (issue: string, signal?: AbortSignal): Promise<LinearLinkableIssue | null> => {
    const data = await client.query(QUERY, { id: issue }, signal ? { signal } : undefined);
    const node = isRecord(data) ? data["issue"] : null;
    if (!isRecord(node)) return null;
    const team = node["team"];
    const state = node["state"];
    const id = readString(node, "id");
    const identifier = readString(node, "identifier");
    const teamId = isRecord(team) ? readString(team, "id") : null;
    if (!id || !identifier || !teamId) throw new Error("Linear returned an incomplete issue.");
    return {
      id,
      identifier,
      url: readString(node, "url"),
      teamId,
      state: isRecord(state) && CLOSED.has(readString(state, "type") ?? "") ? "closed" : "open",
    };
  };
}
