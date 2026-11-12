import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { takeIssueStart, type IssueStartReads } from "./issue-start";
import { projectOverviewFrom } from "./project-scope";
import type { ProjectOverview } from "./project-scope";
import { isRecord, readString } from "./read";

/** What Merging settings match on: the issue's Linear project and label names. */
export type LinearMergeContext = {
  projectId: string | null;
  labels: string[];
  overview?: ProjectOverview | null;
};

const ISSUE_QUERY = `query PawsMergeContext($id: String!) {
  issue(id: $id) {
    project { id name content documents(first: 10, orderBy: updatedAt) { nodes { title content } } }
    labels(first: 100) { nodes { name } }
  }
}`;

function nodes(connection: unknown): Record<string, unknown>[] {
  return isRecord(connection) && Array.isArray(connection["nodes"])
    ? connection["nodes"].filter(isRecord)
    : [];
}

export function createLinearMergeReads(client: LinearClient, starts?: IssueStartReads) {
  return {
    async issueMergeContext(
      issueId: string,
      options?: TrackerRequestOptions,
    ): Promise<LinearMergeContext> {
      options?.signal?.throwIfAborted();
      const data =
        takeIssueStart(starts, issueId, "merge") ??
        (await client.query(ISSUE_QUERY, { id: issueId }, options));
      options?.signal?.throwIfAborted();
      const issue = isRecord(data) ? data["issue"] : null;
      if (!isRecord(issue)) throw new Error("Linear returned no issue for merge settings");
      const project = isRecord(issue["project"]) ? issue["project"] : null;
      return {
        projectId: project ? readString(project, "id") : null,
        labels: nodes(issue["labels"]).flatMap((label) => readString(label, "name") ?? []),
        overview: projectOverviewFrom(project),
      };
    },
  };
}
