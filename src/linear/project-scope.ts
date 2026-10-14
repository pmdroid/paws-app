import type { LinearClient } from "./graphql";
import type { TrackerRequestOptions } from "./adapter";
import type { LinearSubIssue } from "./types";
import { isRecord, readString } from "./read";
import { schedulingMetadata } from "./scheduling";

export type LinearProjectIssue = LinearSubIssue & {
  teamId: string;
  projectId: string;
  parentId: string | null;
  updatedAt: string;
  stateType: string;
};

export type LinearProjectSnapshot = {
  id: string;
  name: string;
  organizationId: string;
  updatedAt: string;
  leadId: string | null;
  issues: readonly LinearProjectIssue[];
};

const QUERY = `query PawsProjectScope($id: String!, $after: String) {
  viewer { app organization { id } }
  project(id: $id) {
    id name updatedAt lead { id }
    issues(first: 50, after: $after, orderBy: createdAt) {
      nodes {
        id identifier title description updatedAt priority
        parent { id } team { id } project { id } assignee { id } state { type }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

export function createLinearProjectScopeReads(client: LinearClient) {
  return {
    async loadProject(id: string, options?: TrackerRequestOptions): Promise<LinearProjectSnapshot> {
      if (!id.trim()) throw new Error("Choose a Linear project.");
      const issues = new Map<string, LinearProjectIssue>();
      const cursors = new Set<string>();
      let after: string | null = null;
      let identity: Omit<LinearProjectSnapshot, "issues"> | null = null;
      for (let page = 0; page < 1000; page++) {
        options?.signal?.throwIfAborted();
        const data = await client.query(QUERY, { id, after }, options);
        options?.signal?.throwIfAborted();
        const viewer = isRecord(data) ? data["viewer"] : null;
        const organization = isRecord(viewer) ? viewer["organization"] : null;
        const project = isRecord(data) ? data["project"] : null;
        if (
          !isRecord(viewer) ||
          viewer["app"] !== true ||
          !isRecord(organization) ||
          !readString(organization, "id") ||
          !isRecord(project) ||
          project["id"] !== id ||
          !readString(project, "name") ||
          !validDate(project["updatedAt"])
        )
          throw new Error("Linear returned an incomplete installed project.");
        const current = {
          id,
          name: readString(project, "name")!,
          organizationId: readString(organization, "id")!,
          updatedAt: project["updatedAt"],
          leadId: nullableId(project["lead"]),
        };
        if (identity !== null && JSON.stringify(identity) !== JSON.stringify(current))
          throw new Error("The Linear project changed during pagination. Refresh its scope.");
        identity = current;
        const connection = project["issues"];
        if (!isRecord(connection) || !Array.isArray(connection["nodes"]))
          throw new Error("Linear returned incomplete project issues.");
        for (const node of connection["nodes"]) {
          if (!isRecord(node)) throw new Error("Linear returned an invalid project issue.");
          const issueId = readString(node, "id");
          const identifier = readString(node, "identifier");
          const title = readString(node, "title");
          const metadata = schedulingMetadata(node);
          const state = node["state"];
          const stateType = isRecord(state) ? readString(state, "type") : null;
          if (
            !issueId ||
            !identifier ||
            !title ||
            !metadata.teamId ||
            metadata.projectId !== id ||
            !stateType ||
            !validDate(node["updatedAt"]) ||
            (node["description"] !== null && typeof node["description"] !== "string") ||
            issues.has(issueId)
          )
            throw new Error("Linear returned incomplete or repeated project issues.");
          issues.set(issueId, {
            ...metadata,
            linearIssueId: issueId,
            identifier,
            title,
            description: node["description"],
            teamId: metadata.teamId,
            projectId: id,
            parentId: nullableId(node["parent"]),
            updatedAt: node["updatedAt"],
            stateType,
          });
        }
        const info = connection["pageInfo"];
        if (!isRecord(info)) throw new Error("Linear returned incomplete project pagination.");
        if (info["hasNextPage"] === false)
          return {
            ...identity,
            issues: [...issues.values()].sort((a, b) =>
              a.linearIssueId.localeCompare(b.linearIssueId),
            ),
          };
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

function nullableId(value: unknown): string | null {
  if (value === null) return null;
  const id = isRecord(value) ? readString(value, "id") : null;
  if (!id) throw new Error("Linear returned an incomplete project relationship.");
  return id;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
