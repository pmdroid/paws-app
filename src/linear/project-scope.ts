import type { LinearClient } from "./graphql";
import type { TrackerRequestOptions } from "./adapter";
import { isRecord, readString } from "./read";

export type ProjectDocument = { title: string; content: string };

/** A Linear project's description and documents. Linear holds them; Paws only reads them. */
export type ProjectOverview = { name: string; content: string; documents?: ProjectDocument[] };

export type LinearProject = { id: string; teamIds: string[] };

export type ProjectOverviewRead = {
  overview: ProjectOverview | null;
  project: LinearProject | null;
};

export const PROJECT_OVERVIEW_MAX = 12_000;
const PROJECT_OVERVIEW_DOCUMENT_MIN = 200;
const PROJECT_OVERVIEW_OMITTED_RESERVE = 64;

/** Every query that feeds `projectOverviewFrom` selects these same project fields. */
const OVERVIEW_QUERY = `query PawsIssueProjectOverview($id: String!) {
  issue(id: $id) { project { id name content documents(first: 10, orderBy: updatedAt) { nodes { title content } } teams(first: 50) { nodes { id } } } }
}`;

export function linearProjectFrom(project: unknown): LinearProject | null {
  if (!isRecord(project)) return null;
  const id = readString(project, "id");
  if (!id) return null;
  const connection = project["teams"];
  const nodes =
    isRecord(connection) && Array.isArray(connection["nodes"]) ? connection["nodes"] : [];
  return { id, teamIds: nodes.filter(isRecord).flatMap((node) => readString(node, "id") ?? []) };
}

/** Null when the project has neither a description nor a document with text. */
export function projectOverviewFrom(project: unknown): ProjectOverview | null {
  if (!isRecord(project)) return null;
  const name = readString(project, "name");
  if (!name) return null;
  const content = readString(project, "content")?.trim() ? readString(project, "content")! : "";
  const connection = project["documents"];
  const nodes =
    isRecord(connection) && Array.isArray(connection["nodes"]) ? connection["nodes"] : [];
  const documents = nodes.filter(isRecord).flatMap((node) => {
    const title = readString(node, "title");
    const body = readString(node, "content");
    return title && body?.trim() ? [{ title, content: body }] : [];
  });
  if (content === "" && documents.length === 0) return null;
  return documents.length ? { name, content, documents } : { name, content };
}

export function projectOverviewText(overview: ProjectOverview | null | undefined): string {
  if (!overview) return "";
  const documents = (overview.documents ?? []).filter((document) => document.content.trim());
  if (!overview.name || (!overview.content.trim() && documents.length === 0)) return "";
  const budget = PROJECT_OVERVIEW_MAX - PROJECT_OVERVIEW_OMITTED_RESERVE;
  const head = clipped(
    overview.content.trim()
      ? `Project overview: ${overview.name}\n\n${overview.content}`
      : `Project: ${overview.name}`,
    budget,
  );
  const parts = [head];
  let used = head.length;
  let omitted = 0;
  for (const document of documents) {
    const room = budget - used - 2;
    if (room < PROJECT_OVERVIEW_DOCUMENT_MIN) {
      omitted++;
      continue;
    }
    const text = clipped(`Project document: ${document.title}\n\n${document.content}`, room);
    parts.push(text);
    used += text.length + 2;
  }
  if (omitted)
    parts.push(
      `[${omitted} more project ${omitted === 1 ? "document is" : "documents are"} in Linear.]`,
    );
  return parts.join("\n\n");
}

function clipped(content: string, max: number): string {
  if (content.length <= max) return content;
  const note = `\n\n[Cut at ${max.toLocaleString("en-US")} characters. The rest is in Linear.]`;
  return `${content.slice(0, Math.max(0, max - note.length))}${note}`;
}

export function createLinearProjectScopeReads(client: LinearClient) {
  return {
    async projectOverview(
      issueId: string,
      options?: TrackerRequestOptions,
    ): Promise<ProjectOverviewRead> {
      options?.signal?.throwIfAborted();
      const data = await client.query(OVERVIEW_QUERY, { id: issueId }, options);
      const issue = isRecord(data) ? data["issue"] : null;
      const project = isRecord(issue) ? issue["project"] : null;
      return { overview: projectOverviewFrom(project), project: linearProjectFrom(project) };
    },
  };
}
