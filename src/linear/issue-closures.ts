import { z } from "zod";
import { closedIssueState, type LinearIssueClosed } from "./administration";
import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";

const CHUNK = 100;
const query = `query IssueClosures($ids: [ID!]!) {
  issues(first: ${CHUNK}, filter: { id: { in: $ids } }, includeArchived: true) {
    nodes { id identifier completedAt canceledAt archivedAt state { type } }
  }
}`;
const time = z.string().nullish();
const responseSchema = z.object({
  issues: z.object({
    nodes: z.array(
      z.object({
        id: z.string(),
        identifier: z.string().nullish(),
        completedAt: time,
        canceledAt: time,
        archivedAt: time,
        state: z.object({ type: z.string() }).nullish(),
      }),
    ),
  }),
});

export function createIssueClosureReads(client: LinearClient) {
  return async function readIssueClosures(
    ids: readonly string[],
    options?: TrackerRequestOptions,
  ): Promise<LinearIssueClosed[]> {
    const closed: LinearIssueClosed[] = [];
    const unique = [...new Set(ids)];
    for (let start = 0; start < unique.length; start += CHUNK) {
      options?.signal?.throwIfAborted();
      const chunk = unique.slice(start, start + CHUNK);
      const { issues } = responseSchema.parse(await client.query(query, { ids: chunk }, options));
      for (const issue of issues.nodes) {
        if (!chunk.includes(issue.id))
          throw new Error("Linear returned an issue it was not asked for.");
        const stateType = closedIssueState(issue.state?.type ?? null);
        const at =
          stateType === "completed"
            ? issue.completedAt
            : stateType === "canceled"
              ? issue.canceledAt
              : null;
        const closedAtMs = Date.parse(at ?? issue.archivedAt ?? "");
        if (!Number.isFinite(closedAtMs)) continue;
        closed.push({
          issueId: issue.id,
          organizationId: null,
          identifier: issue.identifier ?? null,
          stateType: stateType ?? "canceled",
          closedAtMs,
        });
      }
    }
    return closed;
  };
}
