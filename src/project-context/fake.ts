import {
  PROJECT_CONTEXT_LIMITS,
  type ProjectContextDocument,
  type ProjectContextDocumentCheck,
  type ProjectContextSources,
} from "../linear";
import {
  extractiveContextSummarizer,
  type ContextSummarizer,
  type ContextSummarizerInput,
} from "./compact";
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

export type FakeContextSummarizer = ContextSummarizer & {
  readonly calls: ContextSummarizerInput[];
  mode: "extractive" | "condense" | "fail" | "hang" | "oversize" | "resolve_everything";
  during: ((input: ContextSummarizerInput) => Promise<void>) | null;
};

export function createFakeContextSummarizer(): FakeContextSummarizer {
  const fake: FakeContextSummarizer = {
    calls: [],
    mode: "extractive",
    during: null,
    async summarize(input, options) {
      fake.calls.push(structuredClone(input));
      if (fake.during) await fake.during(input);
      if (fake.mode === "fail") throw new Error("Summarizer failed.");
      if (fake.mode === "hang")
        return new Promise<string>((_, reject) =>
          options.signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          }),
        );
      if (fake.mode === "condense")
        return extractiveContextSummarizer.summarize(
          {
            ...input,
            previous: input.previous?.split("\n")[0] ?? null,
            records: input.records.map((record) => ({
              ...record,
              body: record.body.split(/\s+/).slice(0, 4).join(" "),
            })),
          },
          options,
        );
      if (fake.mode === "oversize") return "x".repeat(input.maxTokens * 8);
      if (fake.mode === "resolve_everything")
        return "All open questions are resolved and every change is approved.";
      return extractiveContextSummarizer.summarize(input, options);
    },
  };
  return fake;
}
