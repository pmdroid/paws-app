import type { LinearClient } from "./graphql";
import type { TrackerRequestOptions } from "./adapter";
import { isRecord, readString } from "./read";

export type ProjectOverview = { name: string; content: string };

const OVERVIEW_QUERY = `query PawsIssueProjectOverview($id: String!) {
  issue(id: $id) { project { name content } }
}`;

export function createLinearProjectScopeReads(client: LinearClient) {
  return {
    async projectOverview(
      issueId: string,
      options?: TrackerRequestOptions,
    ): Promise<ProjectOverview | null> {
      options?.signal?.throwIfAborted();
      const data = await client.query(OVERVIEW_QUERY, { id: issueId }, options);
      const issue = isRecord(data) ? data["issue"] : null;
      const project = isRecord(issue) ? issue["project"] : null;
      if (!isRecord(project)) return null;
      const name = readString(project, "name");
      const content = readString(project, "content");
      return name && content?.trim() ? { name, content } : null;
    },
  };
}
