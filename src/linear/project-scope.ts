import type { LinearClient } from "./graphql";
import type { TrackerRequestOptions } from "./adapter";
import { isRecord, readString } from "./read";

export type ProjectDocument = { title: string; content: string };

/** A Linear project's description and documents. Linear holds them; Paws only reads them. */
export type ProjectOverview = { name: string; content: string; documents?: ProjectDocument[] };

const PROJECT_DOCUMENT_MAX = 20_000;

/** Every query that feeds `projectOverviewFrom` selects these same project fields. */
const OVERVIEW_QUERY = `query PawsIssueProjectOverview($id: String!) {
  issue(id: $id) { project { name content documents(first: 10, orderBy: updatedAt) { nodes { title content } } } }
}`;

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

/** The brief's `{{project_overview}}` text: the description, then each document under its title. */
export function projectOverviewText(overview: ProjectOverview | null | undefined): string {
  if (!overview) return "";
  const documents = (overview.documents ?? []).filter((document) => document.content.trim());
  if (!overview.name || (!overview.content.trim() && documents.length === 0)) return "";
  return [
    overview.content.trim()
      ? `Project overview: ${overview.name}\n\n${overview.content}`
      : `Project: ${overview.name}`,
    ...documents.map(
      (document) => `Project document: ${document.title}\n\n${clipped(document.content)}`,
    ),
  ].join("\n\n");
}

function clipped(content: string): string {
  if (content.length <= PROJECT_DOCUMENT_MAX) return content;
  return `${content.slice(0, PROJECT_DOCUMENT_MAX)}\n\n[Document cut at ${PROJECT_DOCUMENT_MAX.toLocaleString("en-US")} characters. The rest is in Linear.]`;
}

export function createLinearProjectScopeReads(client: LinearClient) {
  return {
    async projectOverview(
      issueId: string,
      options?: TrackerRequestOptions,
    ): Promise<ProjectOverview | null> {
      options?.signal?.throwIfAborted();
      const data = await client.query(OVERVIEW_QUERY, { id: issueId }, options);
      const issue = isRecord(data) ? data["issue"] : null;
      return projectOverviewFrom(isRecord(issue) ? issue["project"] : null);
    },
  };
}
