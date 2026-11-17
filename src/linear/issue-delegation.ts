import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";

const QUERY = `query PawsIssueDelegation($id: String!) {
  issue(id: $id) { delegate { id } state { type } }
}`;

const CLOSED = new Set(["completed", "canceled"]);

export function createLinearIssueDelegation(client: LinearClient) {
  return async (issueId: string, viewerId: string, signal?: AbortSignal): Promise<boolean> => {
    const data = await client.query(QUERY, { id: issueId }, signal ? { signal } : undefined);
    const node = isRecord(data) ? data["issue"] : null;
    if (!isRecord(node)) return false;
    const delegate = isRecord(node["delegate"]) ? readString(node["delegate"], "id") : null;
    const state = isRecord(node["state"]) ? readString(node["state"], "type") : null;
    return delegate === viewerId && (state === null || !CLOSED.has(state));
  };
}
