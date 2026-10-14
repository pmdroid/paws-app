import { z } from "zod";
import type { LinearClient } from "./graphql";
import type { TrackerRequestOptions } from "./adapter";

export type IssuePullRequest = { repository: string; pullRequestNumber: number };
const responseSchema = z.object({
  issue: z.object({
    id: z.string(),
    attachments: z.object({
      nodes: z.array(z.object({ id: z.string(), url: z.string() })),
      pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
    }),
  }),
});
const query = `query IssuePullRequests($id: String!, $after: String) {
  issue(id: $id) { id attachments(first: 50, after: $after) {
    nodes { id url } pageInfo { hasNextPage endCursor }
  } }
}`;

export function createIssuePullRequestReads(client: LinearClient) {
  return async function listIssuePullRequests(
    id: string,
    options?: TrackerRequestOptions,
  ): Promise<IssuePullRequest[]> {
    const cursors = new Set<string>();
    const attachments = new Set<string>();
    const pulls = new Map<string, IssuePullRequest>();
    let after: string | null = null;
    for (let page = 0; page < 1000; page++) {
      options?.signal?.throwIfAborted();
      const { issue } = responseSchema.parse(await client.query(query, { id, after }, options));
      options?.signal?.throwIfAborted();
      if (issue.id !== id) throw new Error("Linear returned another blocker issue.");
      for (const attachment of issue.attachments.nodes) {
        if (attachments.has(attachment.id))
          throw new Error("Linear repeated a blocker attachment.");
        attachments.add(attachment.id);
        const match =
          /^https:\/\/github\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+)\/pull\/([1-9][0-9]*)(?:[/?#].*)?$/.exec(
            attachment.url,
          );
        if (!match) continue;
        const number = Number(match[2]);
        if (!Number.isSafeInteger(number)) throw new Error("Invalid linked pull request.");
        const repository = match[1]!.toLowerCase();
        pulls.set(`${repository}/${number}`, { repository, pullRequestNumber: number });
      }
      if (!issue.attachments.pageInfo.hasNextPage) return [...pulls.values()];
      const cursor = issue.attachments.pageInfo.endCursor;
      if (!cursor || cursors.has(cursor))
        throw new Error("Linear blocker attachment pagination did not finish.");
      cursors.add(cursor);
      after = cursor;
    }
    throw new Error("Linear blocker attachment pagination did not finish.");
  };
}
