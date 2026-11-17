import type { LinearClient } from "./graphql";
import type { TrackerRequestOptions } from "./adapter";
import { isRecord, readString } from "./read";

export type ProjectDocument = { title: string; content: string };

/** A Linear project's description and documents. Linear holds them; Paws only reads them. */
export type ProjectOverview = { name: string; content: string; documents?: ProjectDocument[] };

export const PROJECT_OVERVIEW_MAX = 12_000;
const PROJECT_OVERVIEW_DOCUMENT_MIN = 200;

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

export function projectOverviewText(overview: ProjectOverview | null | undefined): string {
  if (!overview) return "";
  const documents = (overview.documents ?? []).filter((document) => document.content.trim());
  if (!overview.name || (!overview.content.trim() && documents.length === 0)) return "";
  const head = clipped(
    overview.content.trim()
      ? `Project overview: ${overview.name}\n\n${overview.content}`
      : `Project: ${overview.name}`,
    PROJECT_OVERVIEW_MAX,
  );
  const parts = [head];
  let used = head.length;
  let omitted = 0;
  for (const document of documents) {
    const room = PROJECT_OVERVIEW_MAX - used;
    if (room < PROJECT_OVERVIEW_DOCUMENT_MIN) {
      omitted++;
      continue;
    }
    const text = clipped(`Project document: ${document.title}\n\n${document.content}`, room);
    parts.push(text);
    used += text.length;
  }
  if (omitted)
    parts.push(
      `[${omitted} more project ${omitted === 1 ? "document is" : "documents are"} in Linear.]`,
    );
  return parts.join("\n\n");
}

function clipped(content: string, max: number): string {
  if (content.length <= max) return content;
  return `${content.slice(0, max)}\n\n[Cut at ${max.toLocaleString("en-US")} characters. The rest is in Linear.]`;
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

export type ProjectContextDocument = {
  id: string;
  title: string;
  url: string;
  revision: string;
  revisionAt: number;
  creatorId: string | null;
  content: string;
};

export type ProjectContextSources = {
  id: string;
  name: string;
  url: string;
  revision: string;
  revisionAt: number;
  teamIds: string[];
  content: string;
  documents: ProjectContextDocument[];
};

export const PROJECT_CONTEXT_LIMITS = {
  documents: 10,
  teams: 20,
  bytesPerSource: 20_000,
  documentsPerCheck: 10,
  checksPerRead: 2,
};

const PROJECT_CONTEXT_QUERY = `query PawsProjectContextSources($id: String!) {
  project(id: $id) {
    id name url updatedAt content
    teams(first: 20) { nodes { id } }
    documents(first: 10, orderBy: updatedAt) { nodes { id title url updatedAt content creator { id } } }
  }
}`;

const PROJECT_CONTEXT_DOCUMENTS_QUERY = `query PawsProjectContextDocuments($ids: [ID!]!) {
  documents(filter: { id: { in: $ids } }, first: 10, includeArchived: true) {
    nodes { id title url updatedAt content archivedAt trashed creator { id } project { id } }
  }
}`;

export type ProjectContextDocumentCheck =
  | { id: string; status: "found"; projectId: string | null; document: ProjectContextDocument }
  | { id: string; status: "removed" | "missing" | "uncertain" };

function clippedBytes(text: string, max: number): string {
  let kept = text;
  while (Buffer.byteLength(kept, "utf8") > max)
    kept = kept.slice(0, Math.floor((kept.length * max) / Buffer.byteLength(kept, "utf8")) - 1);
  return kept;
}

function revisionOf(
  record: Record<string, unknown>,
): { revision: string; revisionAt: number } | null {
  const revision = readString(record, "updatedAt");
  const revisionAt = revision ? Date.parse(revision) : NaN;
  return revision && Number.isFinite(revisionAt) ? { revision, revisionAt } : null;
}

function nodesOf(record: Record<string, unknown>, key: string, max: number) {
  const connection = record[key];
  const nodes =
    isRecord(connection) && Array.isArray(connection["nodes"]) ? connection["nodes"] : [];
  return nodes.filter(isRecord).slice(0, max);
}

function documentFrom(node: Record<string, unknown>): ProjectContextDocument | null {
  const id = readString(node, "id");
  const title = readString(node, "title");
  const url = readString(node, "url");
  const revision = revisionOf(node);
  const creator = node["creator"];
  if (!id || !title || !url || !revision) return null;
  return {
    id,
    title,
    url,
    ...revision,
    creatorId: isRecord(creator) ? readString(creator, "id") : null,
    content: clippedBytes(readString(node, "content") ?? "", PROJECT_CONTEXT_LIMITS.bytesPerSource),
  };
}

export function projectContextDocumentChecksFrom(
  ids: readonly string[],
  data: unknown,
): ProjectContextDocumentCheck[] {
  const connection = isRecord(data) ? data["documents"] : null;
  if (!isRecord(connection) || !Array.isArray(connection["nodes"]))
    return ids.map((id) => ({ id, status: "uncertain" }));
  const nodes = connection["nodes"].filter(isRecord);
  return ids.map((id): ProjectContextDocumentCheck => {
    const node = nodes.find((candidate) => readString(candidate, "id") === id);
    if (!node) return { id, status: "missing" };
    if (node["trashed"] === true || readString(node, "archivedAt"))
      return { id, status: "removed" };
    const document = documentFrom(node);
    if (!document) return { id, status: "uncertain" };
    const project = node["project"];
    return {
      id,
      status: "found",
      projectId: isRecord(project) ? readString(project, "id") : null,
      document,
    };
  });
}

export function projectContextSourcesFrom(project: unknown): ProjectContextSources | null {
  if (!isRecord(project)) return null;
  const id = readString(project, "id");
  const name = readString(project, "name");
  const url = readString(project, "url");
  const revision = revisionOf(project);
  if (!id || !name || !url || !revision) return null;
  const limits = PROJECT_CONTEXT_LIMITS;
  const teamIds = nodesOf(project, "teams", limits.teams).flatMap((team) => {
    const teamId = readString(team, "id");
    return teamId ? [teamId] : [];
  });
  const documents = nodesOf(project, "documents", limits.documents).flatMap((node) => {
    const document = documentFrom(node);
    return document?.content.trim() ? [document] : [];
  });
  return {
    id,
    name,
    url,
    ...revision,
    teamIds,
    content: clippedBytes(readString(project, "content") ?? "", limits.bytesPerSource),
    documents,
  };
}

export function createLinearProjectContextReads(client: LinearClient) {
  return {
    async projectContextSources(
      projectId: string,
      options?: TrackerRequestOptions,
    ): Promise<ProjectContextSources | null> {
      options?.signal?.throwIfAborted();
      const data = await client.query(PROJECT_CONTEXT_QUERY, { id: projectId }, options);
      return projectContextSourcesFrom(isRecord(data) ? data["project"] : null);
    },
    async projectContextDocuments(
      ids: readonly string[],
      options?: TrackerRequestOptions,
    ): Promise<ProjectContextDocumentCheck[]> {
      if (ids.length === 0) return [];
      if (ids.length > PROJECT_CONTEXT_LIMITS.documentsPerCheck)
        throw new Error("Too many project documents in one check.");
      options?.signal?.throwIfAborted();
      const data = await client.query(PROJECT_CONTEXT_DOCUMENTS_QUERY, { ids: [...ids] }, options);
      return projectContextDocumentChecksFrom(ids, data);
    },
  };
}
