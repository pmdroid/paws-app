import {
  contextSourceRestriction,
  contextSummaryLineage,
  currentContextRecords,
  readLinearProjectName,
  listWorkItemProjects,
  workItemIdentifiersInProject,
  listContextPage,
  listContextSummaries,
  type ContextClassification,
  type ContextNamespace,
  type ContextRecordRow,
  type Db,
} from "../db";
import {
  audienceLineage,
  canSee,
  requesterAccess,
  type ContextAccess,
  type ContextRequester,
  type ContextRequesterAccess,
} from "./policy";
import { AGENT_REVISION } from "./remember";
import {
  disclosable,
  forgetContextRecord,
  inspectContext,
  view,
  type ContextRecordView,
} from "./store";

export const CONTEXT_VIEW_LIMITS = {
  pageDefault: 25,
  pageMax: 100,
  open: 10,
  summaries: 4,
  lineage: 50,
  searchChars: 200,
  textChars: 480,
  offsetMax: 10_000,
  projects: 500,
} as const;

export const CONTEXT_VIEW_SCOPES = ["project"] as const;

export type ContextViewScopeKind = (typeof CONTEXT_VIEW_SCOPES)[number];

export type ContextViewSource = {
  kind: string;
  id: string;
  url: string | null;
  revision: string;
  label: string;
};

export type ContextViewRecord = {
  id: string;
  version: number;
  classification: ContextClassification;
  text: string;
  clipped: boolean;
  status: "current" | "superseded";
  corrected: boolean;
  observedAt: number;
  source: ContextViewSource;
  forgettable: boolean;
};

export type ContextViewSummary = {
  id: string;
  version: number;
  builtAt: number | null;
  state: "current" | "stale" | "rebuilding";
  body: string;
  covered: number;
  decisions: number;
  questions: number;
  sources: ContextViewSource[];
};

export type ContextViewPage = { offset: number; limit: number; search: string; more: boolean };

export type ContextView = {
  scope: { kind: ContextViewScopeKind; id: string; name: string | null; url: string | null };
  updatedAt: number | null;
  summaries: ContextViewSummary[];
  decisions: ContextViewRecord[];
  questions: ContextViewRecord[];
  records: ContextViewRecord[];
  page: ContextViewPage;
};

export type ContextViewDetail = {
  record: ContextViewRecord & {
    body: string;
    actorId: string | null;
    correctedBy: string | null;
    supersedes: string | null;
  };
  versions: { id: string; version: number; status: string; observedAt: number; revision: string }[];
};

export type ContextViewRequest = {
  readonly requester: ContextRequester;
  readonly scope: { kind: string; id: string };
  readonly now: number;
  readonly admin?: boolean;
};

const AUDIENCE = "project_members";

const WORK_ITEM_SOURCE = "paws_work_item";

const SOURCE_LABELS: Record<string, string> = {
  linear_project_description: "Linear project description",
  linear_project_document: "Linear document",
};

type Labels = (source: ContextRecordView["source"]) => string;

async function sourceLabels(
  db: Db,
  namespace: ContextNamespace,
  sources: readonly ContextRecordView["source"][],
): Promise<Labels> {
  const identifiers = await workItemIdentifiersInProject(
    db,
    namespace,
    sources.filter((source) => source.kind === WORK_ITEM_SOURCE).map((source) => source.id),
  );
  return (source) => {
    if (source.kind !== WORK_ITEM_SOURCE) return SOURCE_LABELS[source.kind] ?? "Source";
    const identifier = identifiers.get(source.id);
    if (!identifier) return "Work item memory";
    return source.revision.startsWith(AGENT_REVISION)
      ? `Agent on ${identifier}`
      : `Work item memory on ${identifier}`;
  };
}

const viewSource = (source: ContextRecordView["source"], labels: Labels): ContextViewSource => ({
  kind: source.kind,
  id: source.id,
  url: source.url,
  revision: source.revision,
  label: labels(source),
});

function viewRecord(record: ContextRecordView, labels: Labels, admin: boolean): ContextViewRecord {
  const clipped = record.body.length > CONTEXT_VIEW_LIMITS.textChars;
  return {
    id: record.id,
    version: record.version,
    classification: record.classification,
    text: clipped
      ? `${record.body.slice(0, CONTEXT_VIEW_LIMITS.textChars).trimEnd()}…`
      : record.body,
    clipped,
    status: record.status === "superseded" ? "superseded" : "current",
    corrected: record.correctedBy !== null,
    observedAt: record.observedAt,
    source: viewSource(record.source, labels),
    forgettable: admin && record.source.kind === WORK_ITEM_SOURCE && record.status === "current",
  };
}

type Authorized = {
  namespace: ContextNamespace;
  current: ContextRequesterAccess;
  visibility: ContextRequesterAccess & { audience: string; audienceLineage: string };
};

async function projectScope(db: Db, request: Omit<ContextViewRequest, "now">) {
  if (request.scope.kind !== "project" || !/^[\w-]{1,100}$/.test(request.scope.id)) return null;
  const namespace: ContextNamespace = {
    workspaceId: request.requester.workspaceId,
    scopeKind: "linear_project",
    scopeId: request.scope.id,
  };
  const project = await contextSourceRestriction(db, namespace, {
    kind: "linear_project_description",
    id: namespace.scopeId,
  });
  return project?.status === "active" ? { namespace, restriction: project.restriction } : null;
}

async function authorize(db: Db, access: ContextAccess, request: ContextViewRequest) {
  const project = await projectScope(db, request);
  if (!project) return null;
  const { namespace } = project;
  const current = await requesterAccess(access, request.requester);
  if (!current || !canSee(current, project.restriction)) return null;
  const visibility = { ...current, audience: AUDIENCE, audienceLineage: audienceLineage(AUDIENCE) };
  return { namespace, current, visibility } satisfies Authorized;
}

export type ContextProject = { id: string; name: string | null; items: number };

export async function listContextProjects(
  db: Db,
  access: ContextAccess,
  request: { readonly requester: ContextRequester },
): Promise<ContextProject[]> {
  const current = await requesterAccess(access, request.requester);
  if (!current) return [];
  const projects: ContextProject[] = [];
  for (const project of await listWorkItemProjects(db, CONTEXT_VIEW_LIMITS.projects)) {
    const found = await projectScope(db, {
      ...request,
      scope: { kind: "project", id: project.id },
    });
    if (found && canSee(current, found.restriction)) projects.push(project);
  }
  return projects.sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
}

export function contextViewSupported(kind: string): kind is ContextViewScopeKind {
  return (CONTEXT_VIEW_SCOPES as readonly string[]).includes(kind);
}

export async function readContextView(
  db: Db,
  access: ContextAccess,
  request: ContextViewRequest & { offset: number; limit: number; search: string },
): Promise<ContextView | null> {
  const authorized = await authorize(db, access, request);
  if (!authorized) return null;
  const { namespace, current, visibility } = authorized;
  const { now } = request;
  const limit = Math.max(1, Math.min(Math.floor(request.limit), CONTEXT_VIEW_LIMITS.pageMax));
  const offset = Math.max(0, Math.min(Math.floor(request.offset), CONTEXT_VIEW_LIMITS.offsetMax));
  const search = request.search.trim().slice(0, CONTEXT_VIEW_LIMITS.searchChars);
  const readable = (rows: ContextRecordRow[]) =>
    rows.filter((row) => disclosable(row, current, AUDIENCE)).map(view);
  const page = readable(
    await listContextPage(db, { namespace, visibility, now, offset, limit: limit + 1, search }),
  );
  const open = async (classification: ContextClassification) =>
    readable(
      await listContextPage(db, {
        namespace,
        visibility,
        now,
        offset: 0,
        limit: CONTEXT_VIEW_LIMITS.open,
        currentOnly: true,
        classifications: [classification],
      }),
    );
  const [latest] = readable(
    await listContextPage(db, { namespace, visibility, now, offset: 0, limit: 1 }),
  );
  const [description] = readable(
    await listContextPage(db, {
      namespace,
      visibility,
      now,
      offset: 0,
      limit: 1,
      currentOnly: true,
      sourceKinds: ["linear_project_description"],
    }),
  );
  const summaries: (Omit<ContextViewSummary, "sources"> & {
    sources: ContextRecordView["source"][];
  })[] = [];
  for (const summary of await listContextSummaries(db, {
    namespace,
    now,
    visibility,
    limit: CONTEXT_VIEW_LIMITS.summaries,
  })) {
    const lineage = await contextSummaryLineage(db, summary.id, CONTEXT_VIEW_LIMITS.lineage);
    const rows = readable(
      await currentContextRecords(
        db,
        namespace,
        lineage.map((entry) => entry.recordId),
        now,
      ),
    );
    const sources = new Map(
      rows.map((row) => [`${row.source.kind}\0${row.source.id}`, row.source]),
    );
    summaries.push({
      id: summary.id,
      version: summary.version,
      builtAt: summary.builtAt,
      state: summary.requestedAt !== null ? "rebuilding" : summary.valid ? "current" : "stale",
      body: summary.body,
      covered: rows.length,
      decisions: rows.filter((row) => row.classification === "decision").length,
      questions: rows.filter((row) => row.classification === "unresolved_question").length,
      sources: [...sources.values()],
    });
  }
  const decisions = await open("decision");
  const questions = await open("unresolved_question");
  const records = page.slice(0, limit);
  const labels = await sourceLabels(db, namespace, [
    ...[...decisions, ...questions, ...records].map((record) => record.source),
    ...summaries.flatMap((summary) => summary.sources),
  ]);
  const admin = request.admin === true;
  const shown = (rows: ContextRecordView[]) => rows.map((row) => viewRecord(row, labels, admin));
  return {
    scope: {
      kind: "project",
      id: namespace.scopeId,
      name: await readLinearProjectName(db, namespace.scopeId),
      url: description?.source.url ?? null,
    },
    updatedAt: latest?.observedAt ?? null,
    summaries: summaries.map((summary) => ({
      ...summary,
      sources: summary.sources.map((source) => viewSource(source, labels)),
    })),
    decisions: shown(decisions),
    questions: shown(questions),
    records: shown(records),
    page: { offset, limit, search, more: page.length > limit },
  };
}

export async function readContextRecord(
  db: Db,
  access: ContextAccess,
  request: ContextViewRequest & { recordId: string },
): Promise<ContextViewDetail | null> {
  const authorized = await authorize(db, access, request);
  if (!authorized || !/^[\w-]{1,100}$/.test(request.recordId)) return null;
  const found = await inspectContext(db, access, {
    namespace: authorized.namespace,
    requester: request.requester,
    destination: { audience: AUDIENCE },
    recordId: request.recordId,
    now: request.now,
  });
  if (!found) return null;
  const { record } = found;
  const labels = await sourceLabels(db, authorized.namespace, [record.source]);
  return {
    record: {
      ...viewRecord(record, labels, request.admin === true),
      body: record.body,
      actorId: record.actorId,
      correctedBy: record.correctedBy,
      supersedes: record.supersedes,
    },
    versions: found.versions.map((version) => ({
      id: version.id,
      version: version.version,
      status: version.status,
      observedAt: version.observedAt,
      revision: version.source.revision,
    })),
  };
}

export async function forgetViewedContextRecord(
  db: Db,
  access: ContextAccess,
  request: ContextViewRequest & { recordId: string },
): Promise<boolean> {
  const authorized = await authorize(db, access, request);
  if (!authorized || !/^[\w-]{1,100}$/.test(request.recordId)) return false;
  const outcome = await forgetContextRecord(db, access, {
    namespace: authorized.namespace,
    requester: request.requester,
    recordId: request.recordId,
    now: request.now,
  });
  return outcome.status === "forgotten";
}
