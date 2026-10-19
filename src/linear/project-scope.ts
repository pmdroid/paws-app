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

export type ProjectOverview = { name: string; content: string };

const OVERVIEW_QUERY = `query PawsIssueProjectOverview($id: String!) {
  issue(id: $id) { project { name content } }
}`;

const SLUG_QUERY = `query PawsProjectSlug($hash: String!, $slug: String!) {
  projects(first: 2, filter: { or: [{ slugId: { eq: $hash } }, { slugId: { eq: $slug } }] }) {
    nodes { id url }
  }
}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ProjectReference = { id: string } | { hash: string; slug: string };

function projectUrlSegment(value: string): string {
  const segments = URL.canParse(value) ? new URL(value).pathname.split("/").filter(Boolean) : [];
  if (segments[1] !== "project" || !segments[2] || segments[2].includes("%"))
    throw new Error("Paste a Linear project URL or ID.");
  return segments[2];
}

function parseProjectReference(reference: string): ProjectReference {
  let value = reference.trim();
  if (/^https?:\/\//i.test(value)) value = projectUrlSegment(value);
  if (UUID.test(value)) return { id: value };
  const hash = slugHash(value);
  return hash ? { hash, slug: value.toLowerCase() } : { id: value };
}

function slugHash(slug: string): string | null {
  return /(?:^|-)([0-9a-f]{12})$/i.exec(slug)?.[1]?.toLowerCase() ?? null;
}

function matchesHash(node: unknown, hash: string): boolean {
  const url = isRecord(node) ? readString(node, "url") : null;
  if (!url) return false;
  try {
    return slugHash(projectUrlSegment(url)) === hash;
  } catch {
    return false;
  }
}

export function createLinearProjectScopeReads(client: LinearClient) {
  async function resolveProjectId(reference: string, options?: TrackerRequestOptions) {
    const parsed = parseProjectReference(reference);
    if ("id" in parsed) return parsed.id;
    options?.signal?.throwIfAborted();
    const data = await client.query(SLUG_QUERY, parsed, options);
    options?.signal?.throwIfAborted();
    const projects = isRecord(data) ? data["projects"] : null;
    const nodes = isRecord(projects) ? projects["nodes"] : null;
    if (
      !Array.isArray(nodes) ||
      nodes.length !== 1 ||
      !isRecord(nodes[0]) ||
      !matchesHash(nodes[0], parsed.hash)
    )
      throw new Error("No Linear project matches this URL or ID.");
    const id = readString(nodes[0], "id");
    if (!id) throw new Error("Linear returned an incomplete project.");
    return id;
  }
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
    async loadProject(
      reference: string,
      options?: TrackerRequestOptions,
    ): Promise<LinearProjectSnapshot> {
      if (!reference.trim()) throw new Error("Choose a Linear project.");
      const id = await resolveProjectId(reference, options);
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
