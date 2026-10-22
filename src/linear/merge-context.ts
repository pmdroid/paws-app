import type { TrackerRequestOptions } from "./adapter";
import type { LinearClient } from "./graphql";
import { isRecord, readString } from "./read";

/** What Merging settings match on: the issue's Linear project and label names. */
export type LinearMergeContext = { projectId: string | null; labels: string[] };
export type LinearMergeChoices = { projects: { id: string; name: string }[]; labels: string[] };

const ISSUE_QUERY = `query PawsMergeContext($id: String!) {
  issue(id: $id) {
    project { id }
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

export function createLinearMergeReads(client: LinearClient) {
  return {
    async issueMergeContext(
      issueId: string,
      options?: TrackerRequestOptions,
    ): Promise<LinearMergeContext> {
      options?.signal?.throwIfAborted();
      const data = await client.query(ISSUE_QUERY, { id: issueId }, options);
      options?.signal?.throwIfAborted();
      const issue = isRecord(data) ? data["issue"] : null;
      if (!isRecord(issue)) throw new Error("Linear returned no issue for merge settings");
      const project = issue["project"];
      return {
        projectId: isRecord(project) ? readString(project, "id") : null,
        labels: nodes(issue["labels"]).flatMap((label) => readString(label, "name") ?? []),
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
