import {
  PROJECT_CONTEXT_LIMITS,
  type ProjectContextDocument,
  type ProjectContextDocumentCheck,
  type ProjectContextSources,
} from "../linear";
import type { ProjectContextReads } from "./linear";

export type FakeProjectDocument = ProjectContextDocument & {
  projectId: string;
  trashed?: boolean;
  hidden?: boolean;
};

export type FakeProjectContextReads = ProjectContextReads & {
  readonly projects: Map<string, Omit<ProjectContextSources, "documents">>;
  readonly documents: Map<string, FakeProjectDocument>;
  readonly calls: { kind: "project" | "documents"; ids: string[] }[];
  readonly failures: { project?: Error; documents?: Error };
};

export function createFakeProjectContextReads(): FakeProjectContextReads {
  const projects = new Map<string, Omit<ProjectContextSources, "documents">>();
  const documents = new Map<string, FakeProjectDocument>();
  const calls: { kind: "project" | "documents"; ids: string[] }[] = [];
  const failures: { project?: Error; documents?: Error } = {};
  const plain = ({ projectId: _p, trashed: _t, hidden: _h, ...document }: FakeProjectDocument) =>
    structuredClone(document);
  return {
    projects,
    documents,
    calls,
    failures,
    async projectContextSources(projectId) {
      calls.push({ kind: "project", ids: [projectId] });
      if (failures.project) throw failures.project;
      const project = projects.get(projectId);
      if (!project) return null;
      const listed = [...documents.values()]
        .filter(
          (document) =>
            document.projectId === projectId &&
            !document.trashed &&
            !document.hidden &&
            document.content.trim(),
        )
        .sort((a, b) => b.revisionAt - a.revisionAt)
        .slice(0, PROJECT_CONTEXT_LIMITS.documents)
        .map(plain);
      return { ...structuredClone(project), documents: listed };
    },
    async projectContextDocuments(ids) {
      calls.push({ kind: "documents", ids: [...ids] });
      if (ids.length > PROJECT_CONTEXT_LIMITS.documentsPerCheck)
        throw new Error("Too many project documents in one check.");
      if (failures.documents) throw failures.documents;
      return ids.map((id): ProjectContextDocumentCheck => {
        const document = documents.get(id);
        if (!document || document.hidden) return { id, status: "missing" };
        if (document.trashed) return { id, status: "removed" };
        return { id, status: "found", projectId: document.projectId, document: plain(document) };
      });
    },
  };
}
