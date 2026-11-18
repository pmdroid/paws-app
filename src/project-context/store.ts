import {
  connectContextScope,
  contextRecordHistory,
  contextSourceRestriction,
  correctContextRecord,
  disconnectContextScope,
  forgetContextEntry,
  ingestContextSource,
  invalidateContextSource,
  listContextCandidates,
  readdContextSource,
  sweepContextRetention,
  type ContextClaim,
  type ContextClassification,
  type ContextIngestResult,
  type ContextInvalidation,
  type ContextLayer,
  type ContextNamespace,
  type ContextRecordRow,
  type ContextSourceRef,
  type ContextSourceRevision,
  type Db,
} from "../db";
import {
  audienceFor,
  audienceLineage,
  canSee,
  destinationAllowed,
  requesterAccess,
  sourceAllowed,
  validNamespace,
  type ContextAccess,
  type ContextAudience,
  type ContextDestination,
  type ContextRequester,
  type ContextRequesterAccess,
} from "./policy";
import { sanitizedContextText } from "./sanitize";

const DAY_MS = 24 * 60 * 60 * 1000;

export const CONTEXT_RETENTION = {
  retentionMs: 180 * DAY_MS,
  historyMs: 30 * DAY_MS,
  workspaceCap: 10_000,
  scopeCap: 2_000,
  sweepBatch: 500,
  sourceCheckMs: 60 * 60 * 1000,
} as const;

export const CONTEXT_CLAIM_LIMITS = {
  claimsPerSource: 40,
  bytes: { source_text: 20_000, observation: 1_000, summary: 4_000 } satisfies Record<
    ContextLayer,
    number
  >,
} as const;

export const CONTEXT_QUERY_LIMITS = {
  records: 50,
  bytes: 32_000,
  candidates: 200,
  versions: 20,
} as const;

export type ContextRecordView = {
  id: string;
  version: number;
  layer: ContextLayer;
  classification: ContextClassification;
  importance: number;
  body: string;
  source: { kind: string; id: string; url: string | null; revision: string };
  actorId: string | null;
  correctedBy: string | null;
  supersedes: string | null;
  observedAt: number;
  audienceLineage: string;
  status: ContextRecordRow["status"];
};

export function view(row: ContextRecordRow): ContextRecordView {
  return {
    id: row.id,
    version: row.version,
    layer: row.layer,
    classification: row.classification,
    importance: row.importance,
    body: row.body,
    source: {
      kind: row.sourceKind,
      id: row.sourceId,
      url: row.sourceUrl,
      revision: row.sourceRevision,
    },
    actorId: row.actorId,
    correctedBy: row.correctedBy,
    supersedes: row.supersedes,
    observedAt: row.observedAt,
    audienceLineage: row.audienceLineage,
    status: row.status,
  };
}

export function disclosable(
  row: ContextRecordRow,
  access: ContextRequesterAccess,
  audience: ContextAudience,
): boolean {
  return (
    row.audience === audience &&
    row.audienceLineage === audienceLineage(audience) &&
    canSee(access, row.restriction)
  );
}

export type ContextIngestRequest = {
  readonly namespace: ContextNamespace;
  readonly requester: ContextRequester;
  readonly source: ContextSourceRevision;
  readonly claims: readonly ContextClaim[];
  readonly now: number;
};

export type ContextIngestOutcome = ContextIngestResult | { status: "refused" };

function sanitizedClaims(claims: readonly ContextClaim[]): ContextClaim[] {
  return claims
    .slice(0, CONTEXT_CLAIM_LIMITS.claimsPerSource)
    .map((claim) => ({
      ...claim,
      importance: Math.max(0, Math.min(5, Math.round(claim.importance))),
      body: sanitizedContextText(claim.body, CONTEXT_CLAIM_LIMITS.bytes[claim.layer]),
    }))
    .filter((claim) => claim.body !== "" && claim.key.trim() !== "");
}

export async function ingestContext(
  db: Db,
  access: ContextAccess,
  request: ContextIngestRequest,
): Promise<ContextIngestOutcome> {
  const { namespace, requester, source } = request;
  if (!sourceAllowed(namespace, source) || requester.workspaceId !== namespace.workspaceId)
    return { status: "refused" };
  if (!Number.isFinite(source.revisionAt)) return { status: "refused" };
  const current = await requesterAccess(access, requester);
  if (!current || !canSee(current, source.restriction)) return { status: "refused" };
  const audience = audienceFor(namespace);
  return ingestContextSource(db, {
    namespace,
    source,
    claims: sanitizedClaims(request.claims),
    audience,
    audienceLineage: audienceLineage(audience),
    limits: CONTEXT_RETENTION,
    now: request.now,
  });
}

export type ContextQuery = {
  readonly namespace: ContextNamespace;
  readonly requester: ContextRequester;
  readonly destination: ContextDestination;
  readonly limit: number;
  readonly maxBytes: number;
  readonly now: number;
};

export type ContextQueryResult =
  | { status: "ok"; generation: number; records: ContextRecordView[]; bytes: number }
  | { status: "refused" };

export async function queryContext(
  db: Db,
  access: ContextAccess,
  query: ContextQuery,
): Promise<ContextQueryResult> {
  const { namespace, requester, destination } = query;
  if (!destinationAllowed(namespace, requester, destination)) return { status: "refused" };
  const limit = Math.max(0, Math.min(Math.floor(query.limit), CONTEXT_QUERY_LIMITS.records));
  const maxBytes = Math.max(0, Math.min(Math.floor(query.maxBytes), CONTEXT_QUERY_LIMITS.bytes));
  const current = await requesterAccess(access, requester);
  if (!current || limit === 0 || maxBytes === 0)
    return { status: "ok", generation: 0, records: [], bytes: 0 };
  const audience = destination.audience;
  const candidates = await listContextCandidates(db, {
    namespace,
    visibility: {
      userId: current.userId,
      teamIds: current.teamIds,
      repositories: current.repositories,
      channelIds: current.channelIds,
      audience,
      audienceLineage: audienceLineage(audience),
    },
    now: query.now,
    candidates: CONTEXT_QUERY_LIMITS.candidates,
  });
  const records: ContextRecordView[] = [];
  let bytes = 0;
  for (const row of candidates.records) {
    if (records.length >= limit) break;
    if (!disclosable(row, current, destination.audience)) continue;
    if (bytes + row.bodyBytes > maxBytes) continue;
    bytes += row.bodyBytes;
    records.push(view(row));
  }
  return { status: "ok", generation: candidates.generation, records, bytes };
}

export type ContextInspection = { record: ContextRecordView; versions: ContextRecordView[] };

export async function inspectContext(
  db: Db,
  access: ContextAccess,
  request: {
    namespace: ContextNamespace;
    requester: ContextRequester;
    destination: ContextDestination;
    recordId: string;
    now: number;
  },
): Promise<ContextInspection | null> {
  const { namespace, requester, destination } = request;
  if (!destinationAllowed(namespace, requester, destination)) return null;
  const current = await requesterAccess(access, requester);
  if (!current) return null;
  const found = await contextRecordHistory(
    db,
    namespace,
    request.recordId,
    CONTEXT_QUERY_LIMITS.versions,
    request.now,
  );
  if (!found || !disclosable(found.record, current, destination.audience)) return null;
  return {
    record: view(found.record),
    versions: found.versions
      .filter((row) => disclosable(row, current, destination.audience))
      .map(view),
  };
}

export type ContextCorrectionOutcome =
  | { status: "corrected"; record: ContextRecordView; invalidation: ContextInvalidation }
  | { status: "refused" | "upgrade_refused" };

export async function correctContext(
  db: Db,
  access: ContextAccess,
  request: {
    namespace: ContextNamespace;
    requester: ContextRequester;
    recordId: string;
    body: string;
    classification?: ContextClassification;
    now: number;
  },
): Promise<ContextCorrectionOutcome> {
  const { namespace, requester } = request;
  if (!validNamespace(namespace) || requester.workspaceId !== namespace.workspaceId)
    return { status: "refused" };
  const current = await requesterAccess(access, requester);
  if (!current) return { status: "refused" };
  const found = await contextRecordHistory(db, namespace, request.recordId, 1, request.now);
  if (!found || found.record.status !== "current" || !canSee(current, found.record.restriction))
    return { status: "refused" };
  const body = sanitizedContextText(request.body, CONTEXT_CLAIM_LIMITS.bytes[found.record.layer]);
  if (body === "") return { status: "refused" };
  const result = await correctContextRecord(db, {
    namespace,
    recordId: request.recordId,
    body,
    ...(request.classification ? { classification: request.classification } : {}),
    actorId: requester.userId,
    limits: CONTEXT_RETENTION,
    now: request.now,
  });
  if (result.status === "corrected")
    return {
      status: "corrected",
      record: view(result.record),
      invalidation: result.invalidation,
    };
  return { status: result.status === "upgrade_refused" ? "upgrade_refused" : "refused" };
}

async function authorizedForSource(
  db: Db,
  access: ContextAccess,
  namespace: ContextNamespace,
  requester: ContextRequester,
  source: ContextSourceRef,
): Promise<boolean> {
  if (!sourceAllowed(namespace, source) || requester.workspaceId !== namespace.workspaceId)
    return false;
  const state = await contextSourceRestriction(db, namespace, source);
  if (!state) return false;
  const current = await requesterAccess(access, requester);
  return current !== null && canSee(current, state.restriction);
}

export type ContextForgetOutcome =
  | { status: "forgotten"; invalidation: ContextInvalidation }
  | { status: "refused" };

export async function forgetContextSource(
  db: Db,
  access: ContextAccess,
  request: {
    namespace: ContextNamespace;
    requester: ContextRequester;
    source: ContextSourceRef;
    now: number;
  },
): Promise<ContextForgetOutcome> {
  const { namespace, requester, source } = request;
  if (!(await authorizedForSource(db, access, namespace, requester, source)))
    return { status: "refused" };
  const invalidation = await invalidateContextSource(db, {
    namespace,
    source,
    reason: "forgotten",
    actorId: requester.userId,
    now: request.now,
  });
  return { status: "forgotten", invalidation };
}

const FORGETTABLE_CONTEXT_SOURCE = "paws_work_item";

export type ContextEntryForgetOutcome =
  | { status: "forgotten"; invalidation: ContextInvalidation }
  | { status: "refused" };

export async function forgetContextRecord(
  db: Db,
  access: ContextAccess,
  request: {
    namespace: ContextNamespace;
    requester: ContextRequester;
    recordId: string;
    now: number;
  },
): Promise<ContextEntryForgetOutcome> {
  const { namespace, requester } = request;
  if (!validNamespace(namespace) || requester.workspaceId !== namespace.workspaceId)
    return { status: "refused" };
  const current = await requesterAccess(access, requester);
  if (!current) return { status: "refused" };
  const found = await contextRecordHistory(db, namespace, request.recordId, 1, request.now);
  if (
    !found ||
    found.record.sourceKind !== FORGETTABLE_CONTEXT_SOURCE ||
    !canSee(current, found.record.restriction)
  )
    return { status: "refused" };
  const source = { kind: found.record.sourceKind, id: found.record.sourceId };
  if (!(await authorizedForSource(db, access, namespace, requester, source)))
    return { status: "refused" };
  const result = await forgetContextEntry(db, {
    namespace,
    recordId: request.recordId,
    sourceKind: FORGETTABLE_CONTEXT_SOURCE,
    actorId: requester.userId,
    now: request.now,
  });
  return result.status === "forgotten"
    ? { status: "forgotten", invalidation: result.invalidation }
    : { status: "refused" };
}

export async function readdContext(
  db: Db,
  access: ContextAccess,
  request: {
    namespace: ContextNamespace;
    requester: ContextRequester;
    source: ContextSourceRef;
    now: number;
  },
): Promise<boolean> {
  const { namespace, requester, source } = request;
  if (!(await authorizedForSource(db, access, namespace, requester, source))) return false;
  return readdContextSource(db, { namespace, source, actorId: requester.userId, now: request.now });
}

export async function invalidateContext(
  db: Db,
  request: {
    namespace: ContextNamespace;
    source: ContextSourceRef;
    reason: "deleted" | "revoked";
    now: number;
  },
): Promise<ContextInvalidation | null> {
  if (!sourceAllowed(request.namespace, request.source)) return null;
  return invalidateContextSource(db, { ...request, actorId: null });
}

export async function disconnectContext(
  db: Db,
  request: { namespace: ContextNamespace; actorId: string | null; now: number },
): Promise<ContextInvalidation | null> {
  if (!validNamespace(request.namespace)) return null;
  return disconnectContextScope(db, request);
}

export async function reconnectContext(
  db: Db,
  request: { namespace: ContextNamespace; actorId: string; now: number },
): Promise<number | null> {
  if (!validNamespace(request.namespace)) return null;
  return connectContextScope(db, request);
}

export async function sweepContext(db: Db, now: number) {
  return sweepContextRetention(db, {
    now,
    historyMs: CONTEXT_RETENTION.historyMs,
    batch: CONTEXT_RETENTION.sweepBatch,
  });
}
