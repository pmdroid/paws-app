import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { takeIssueStart, type IssueStartReads } from "./issue-start";
import type { ProjectOverview } from "./project-scope";
import { isRecord, readString } from "./read";

/** What Merging settings match on: the issue's Linear project and label names. */
export type LinearMergeContext = {
  projectId: string | null;
  labels: string[];
  overview?: ProjectOverview | null;
};
export type LinearMergeChoices = { projects: { id: string; name: string }[]; labels: string[] };

const ISSUE_QUERY = `query PawsMergeContext($id: String!) {
  issue(id: $id) {
    project { id name content }
    labels(first: 100) { nodes { name } }
  }
}`;

const CHOICES_QUERY = `query PawsMergeChoices {
  projects(first: 250) { nodes { id name } }
  issueLabels(first: 250, filter: { isGroup: { eq: false } }) { nodes { name } }
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
      const name = project ? readString(project, "name") : null;
      const content = project ? readString(project, "content") : null;
      return {
        projectId: project ? readString(project, "id") : null,
        labels: nodes(issue["labels"]).flatMap((label) => readString(label, "name") ?? []),
        overview: name && content?.trim() ? { name, content } : null,
      };
    },
    async mergeChoices(options?: TrackerRequestOptions): Promise<LinearMergeChoices> {
      options?.signal?.throwIfAborted();
      const data = await client.query(CHOICES_QUERY, {}, options);
      options?.signal?.throwIfAborted();
      if (!isRecord(data)) throw new Error("Linear returned no merge choices");
      const projects = nodes(data["projects"]).flatMap((project) => {
        const id = readString(project, "id");
        const name = readString(project, "name");
        return id === null || name === null ? [] : [{ id, name }];
      });
      const labels = [
        ...new Set(nodes(data["issueLabels"]).flatMap((label) => readString(label, "name") ?? [])),
      ];
      const byName = (left: string, right: string) => left.localeCompare(right);
      return {
        projects: projects.sort((left, right) => byName(left.name, right.name)),
        labels: labels.sort(byName),
      };
    },
  };
}
