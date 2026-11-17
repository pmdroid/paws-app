import {
  listContextSourcesToCheck,
  markContextSourcesUnverified,
  type ContextClaim,
  type ContextClassification,
  type ContextInvalidation,
  type ContextNamespace,
  type ContextSourceRevision,
  type Db,
} from "../db";
import {
  PROJECT_CONTEXT_LIMITS,
  type ProjectContextDocument,
  type ProjectContextDocumentCheck,
  type ProjectContextSources,
} from "../linear";
import type { ContextAccess, ContextRequester } from "./policy";
import { contextKey } from "./sanitize";
import {
  CONTEXT_RETENTION,
  ingestContext,
  invalidateContext,
  type ContextIngestOutcome,
} from "./store";

export type ProjectContextReads = {
  projectContextSources(
    projectId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProjectContextSources | null>;
  projectContextDocuments(
    ids: readonly string[],
    options?: { signal?: AbortSignal },
  ): Promise<ProjectContextDocumentCheck[]>;
};

const SOURCE_KINDS = ["linear_project_description", "linear_project_document"];
const DOCUMENT = "linear_project_document";

const OBSERVATIONS_PER_SOURCE = 20;

const SECTIONS: readonly [RegExp, ContextClassification][] = [
  [/\bdecision|\bdecided\b/i, "decision"],
  [/open question|unresolved|\bquestions?\b/i, "unresolved_question"],
  [/constraint|requirement|boundar|non-goal|exclusion/i, "reported_fact"],
];

const PREFIXES: readonly [RegExp, ContextClassification][] = [
  [/^(?:decision|decided)\s*:\s*(.+)$/i, "decision"],
  [/^(?:open question|question|unresolved)\s*:\s*(.+)$/i, "unresolved_question"],
  [/^(?:constraint|requirement)\s*:\s*(.+)$/i, "reported_fact"],
];

const IMPORTANCE: Record<ContextClassification, number> = {
  decision: 3,
  unresolved_question: 2,
  reported_fact: 1,
  verified_fact: 1,
  inference: 0,
};

export function projectContextClaims(text: string): ContextClaim[] {
  const claims: ContextClaim[] = [];
  const add = (classification: ContextClassification, body: string) => {
    if (claims.length >= OBSERVATIONS_PER_SOURCE || body.trim().length < 3) return;
    claims.push({
      key: contextKey("observation", body),
      layer: "observation",
      classification,
      importance: IMPORTANCE[classification],
      body: body.trim(),
    });
  };
  let section: ContextClassification | null = null;
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      section = SECTIONS.find(([pattern]) => pattern.test(heading[1]!))?.[1] ?? null;
      continue;
    }
    const content = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim();
    const prefixed = PREFIXES.flatMap(([pattern, classification]) => {
      const match = pattern.exec(content);
      return match ? [[classification, match[1]!] as const] : [];
    })[0];
    if (prefixed) add(prefixed[0], prefixed[1]);
    else if (section && content !== line.trim()) add(section, content);
  }
  return claims;
}

function claimsFor(text: string): ContextClaim[] {
  if (!text.trim()) return [];
  return [
    {
      key: "source_text",
      layer: "source_text",
      classification: "reported_fact",
      importance: 1,
      body: text,
    },
    ...projectContextClaims(text),
  ];
}

export type LinearProjectContextIngest = {
  status: "read" | "unavailable";
  sources: { kind: string; id: string; outcome: ContextIngestOutcome["status"] | "invalidated" }[];
  invalidations: ContextInvalidation[];
};

export async function ingestLinearProjectContext(
  db: Db,
  access: ContextAccess,
  reads: ProjectContextReads,
  request: {
    workspaceId: string;
    projectId: string;
    requester: ContextRequester;
    now: number;
    signal?: AbortSignal;
  },
): Promise<LinearProjectContextIngest> {
  const unavailable: LinearProjectContextIngest = {
    status: "unavailable",
    sources: [],
    invalidations: [],
  };
  if (request.requester.workspaceId !== request.workspaceId) return unavailable;
  const namespace: ContextNamespace = {
    workspaceId: request.workspaceId,
    scopeKind: "linear_project",
    scopeId: request.projectId,
  };
  const options = request.signal ? { signal: request.signal } : undefined;
  const withhold = async (
    selection: Omit<Parameters<typeof markContextSourcesUnverified>[1], "namespace" | "now">,
  ) => markContextSourcesUnverified(db, { namespace, ...selection, now: request.now });
  let project: ProjectContextSources | null;
  try {
    project = await reads.projectContextSources(request.projectId, options);
  } catch {
    project = null;
  }
  if (!project || project.id !== request.projectId || project.teamIds.length === 0) {
    const withheld = await withhold({ sourceKinds: SOURCE_KINDS });
    return { ...unavailable, invalidations: withheld.records.length ? [withheld] : [] };
  }
  const restriction = { teamIds: project.teamIds };
  const documentSource = (document: ProjectContextDocument) => ({
    source: {
      kind: DOCUMENT,
      id: document.id,
      url: document.url,
      revision: document.revision,
      revisionAt: document.revisionAt,
      actorId: document.creatorId,
      restriction,
    },
    text: document.content.trim() ? `${document.title}\n\n${document.content}` : "",
  });
  const sources: { source: ContextSourceRevision; text: string }[] = [
    {
      source: {
        kind: "linear_project_description",
        id: project.id,
        url: project.url,
        revision: project.revision,
        revisionAt: project.revisionAt,
        actorId: null,
        restriction,
      },
      text: project.content,
    },
    ...project.documents.map(documentSource),
  ];
  const result: LinearProjectContextIngest = { status: "read", sources: [], invalidations: [] };
  const ingest = async ({ source, text }: { source: ContextSourceRevision; text: string }) => {
    const outcome = await ingestContext(db, access, {
      namespace,
      requester: request.requester,
      source,
      claims: claimsFor(text),
      now: request.now,
    });
    result.sources.push({ kind: source.kind, id: source.id, outcome: outcome.status });
    if (outcome.status === "stored") result.invalidations.push(outcome.invalidation);
  };
  for (const entry of sources) await ingest(entry);
  const first = result.sources[0]?.outcome;
  if (first === "refused" || first === "disconnected") return result;

  const listedIds = project.documents.map((document) => document.id);
  const stale = await withhold({
    sourceKinds: [DOCUMENT],
    exceptIds: listedIds,
    verifiedBefore: request.now - CONTEXT_RETENTION.sourceCheckMs,
  });
  if (stale.records.length) result.invalidations.push(stale);
  const limits = PROJECT_CONTEXT_LIMITS;
  const retained = await listContextSourcesToCheck(db, {
    namespace,
    sourceKind: DOCUMENT,
    exceptIds: listedIds,
    limit: limits.documentsPerCheck * limits.checksPerRead,
  });
  const unconfirmed: string[] = [];
  for (let start = 0; start < retained.length; start += limits.documentsPerCheck) {
    const batch = retained.slice(start, start + limits.documentsPerCheck);
    let checks: ProjectContextDocumentCheck[];
    try {
      checks = await reads.projectContextDocuments(batch, options);
    } catch {
      unconfirmed.push(...batch);
      continue;
    }
    for (const id of batch) {
      const check = checks.find((candidate) => candidate.id === id);
      if (!check || check.status === "uncertain") {
        unconfirmed.push(id);
        continue;
      }
      if (check.status === "found" && check.projectId === project.id) {
        await ingest(documentSource(check.document));
        if (result.sources.at(-1)?.outcome !== "stored") unconfirmed.push(id);
        continue;
      }
      const invalidation = await invalidateContext(db, {
        namespace,
        source: { kind: DOCUMENT, id },
        reason: check.status === "found" ? "revoked" : "deleted",
        now: request.now,
      });
      if (invalidation) result.invalidations.push(invalidation);
      result.sources.push({ kind: DOCUMENT, id, outcome: "invalidated" });
    }
  }
  const uncertain = await withhold({ sourceKinds: [DOCUMENT], onlyIds: unconfirmed });
  if (uncertain.records.length) result.invalidations.push(uncertain);
  return result;
}
