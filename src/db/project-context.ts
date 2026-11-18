import { createHash } from "node:crypto";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { type Db, type Q } from "./db";
import { clearDependentContextSummariesSteps } from "./project-context-summary";
import { ulid } from "./ulid";

export type ContextScopeKind = "linear_project" | "slack_channel" | "user_private";

export type ContextNamespace = {
  readonly workspaceId: string;
  readonly scopeKind: ContextScopeKind;
  readonly scopeId: string;
};

export type ContextLayer = "source_text" | "observation" | "summary";

export type ContextClassification =
  | "decision"
  | "verified_fact"
  | "reported_fact"
  | "inference"
  | "unresolved_question";

export type ContextRestriction = {
  readonly teamIds?: readonly string[];
  readonly repository?: string;
  readonly ref?: string;
  readonly userId?: string;
  readonly channelId?: string;
};

export type ContextSourceRef = { readonly kind: string; readonly id: string };

export type ContextSourceRevision = ContextSourceRef & {
  readonly url: string | null;
  readonly revision: string;
  readonly revisionAt: number;
  readonly actorId: string | null;
  readonly restriction: ContextRestriction;
};

export type ContextClaim = {
  readonly key: string;
  readonly layer: ContextLayer;
  readonly classification: ContextClassification;
  readonly importance: number;
  readonly body: string;
};

export type ContextLimits = {
  readonly retentionMs: number;
  readonly workspaceCap: number;
  readonly scopeCap: number;
};

export type ContextInvalidationReason =
  | "edited"
  | "forgotten"
  | "deleted"
  | "revoked"
  | "expired"
  | "disconnected"
  | "retention"
  | "unverified";

export type ContextAffectedRecord = {
  readonly id: string;
  readonly namespace: ContextNamespace;
  readonly sourceKind: string;
  readonly sourceId: string;
  readonly version: number;
  readonly reason: ContextInvalidationReason | "superseded";
};

export type ContextInvalidation = {
  readonly scopes: readonly { namespace: ContextNamespace; generation: number }[];
  readonly records: readonly ContextAffectedRecord[];
};

export type ContextIngestResult =
  | {
      status: "stored";
      inserted: number;
      refreshed: number;
      unchanged: number;
      invalidation: ContextInvalidation;
    }
  | { status: "forgotten" | "stale" | "disconnected" };

export type ContextRecordRow = {
  id: string;
  namespace: ContextNamespace;
  sourceKind: string;
  sourceId: string;
  sourceUrl: string | null;
  sourceRevision: string;
  sourceRevisionAt: number;
  actorId: string | null;
  observedAt: number;
  recordKey: string;
  layer: ContextLayer;
  classification: ContextClassification;
  importance: number;
  body: string;
  bodyBytes: number;
  audience: string;
  audienceLineage: string;
  restriction: ContextRestriction;
  version: number;
  status: "current" | "superseded" | "invalidated";
  supersedes: string | null;
  correctedBy: string | null;
  invalidatedReason: string | null;
  expiresAt: number;
};

export type ContextCorrectionResult =
  | { status: "corrected"; record: ContextRecordRow; invalidation: ContextInvalidation }
  | { status: "not_found" | "upgrade_refused" };

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const hashOf = (text: string) => createHash("sha256").update(text).digest("hex");

function nsWhere(
  table: { workspaceId: PgColumn; scopeKind: PgColumn; scopeId: PgColumn },
  namespace: ContextNamespace,
) {
  return and(
    eq(table.workspaceId, namespace.workspaceId),
    eq(table.scopeKind, namespace.scopeKind),
    eq(table.scopeId, namespace.scopeId),
  )!;
}

function* bumpScopeSteps(q: Q, namespace: ContextNamespace, now: number) {
  const { contextScope } = q.t;
  const row = yield* q.one(
    q.orm
      .insert(contextScope)
      .values({ ...namespace, status: "connected", generation: 1, changedAt: now })
      .onConflictDoUpdate({
        target: [contextScope.workspaceId, contextScope.scopeKind, contextScope.scopeId],
        set: { generation: sql`context_scope.generation + 1`, changedAt: now },
      })
      .returning({ generation: contextScope.generation }),
  );
  return row!.generation;
}

function* scopeStatusSteps(q: Q, namespace: ContextNamespace) {
  const { contextScope } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ status: contextScope.status, generation: contextScope.generation })
      .from(contextScope)
      .where(nsWhere(contextScope, namespace)),
  );
  return row ?? null;
}

function* auditSteps(
  q: Q,
  namespace: ContextNamespace,
  action: string,
  actorId: string | null,
  source: ContextSourceRef | null,
  now: number,
) {
  yield* q.exec(
    q.orm.insert(q.t.contextAudit).values({
      id: ulid(now),
      ...namespace,
      action,
      actorId,
      sourceKind: source?.kind ?? null,
      sourceId: source?.id ?? null,
      at: now,
    }),
  );
}

function sourceWhere(q: Q, namespace: ContextNamespace, source: ContextSourceRef) {
  const { contextSource } = q.t;
  return and(
    nsWhere(contextSource, namespace),
    eq(contextSource.sourceKind, source.kind),
    eq(contextSource.sourceId, source.id),
  )!;
}

function recordSourceWhere(q: Q, namespace: ContextNamespace, source: ContextSourceRef) {
  const { contextRecord } = q.t;
  return and(
    nsWhere(contextRecord, namespace),
    eq(contextRecord.sourceKind, source.kind),
    eq(contextRecord.sourceId, source.id),
  )!;
}

function* sourceStateSteps(q: Q, namespace: ContextNamespace, source: ContextSourceRef) {
  const { contextSource } = q.t;
  return yield* q.one(
    q.orm
      .select({
        status: contextSource.status,
        revisionAt: contextSource.revisionAt,
        blockedThrough: contextSource.blockedThrough,
        restriction: contextSource.restriction,
      })
      .from(contextSource)
      .where(sourceWhere(q, namespace, source)),
  );
}

type InvalidatedRow = {
  id: string;
  workspaceId: string;
  scopeKind: string;
  scopeId: string;
  sourceKind: string;
  sourceId: string;
  version: number;
  sourceRevisionAt: number;
};

function* invalidateRowsSteps(
  q: Q,
  where: ReturnType<typeof and>,
  reason: ContextInvalidationReason,
  now: number,
) {
  const { contextRecord } = q.t;
  const rows: InvalidatedRow[] = yield* q.all(
    q.orm
      .update(contextRecord)
      .set({
        status: "invalidated",
        body: "",
        bodyBytes: 0,
        invalidatedReason: reason,
        invalidatedAt: now,
      })
      .where(and(where, ne(contextRecord.status, "invalidated")))
      .returning({
        id: contextRecord.id,
        workspaceId: contextRecord.workspaceId,
        scopeKind: contextRecord.scopeKind,
        scopeId: contextRecord.scopeId,
        sourceKind: contextRecord.sourceKind,
        sourceId: contextRecord.sourceId,
        version: contextRecord.version,
        sourceRevisionAt: contextRecord.sourceRevisionAt,
      }),
  );
  yield* clearDependentContextSummariesSteps(
    q,
    rows.map((row) => row.id),
    now,
  );
  return rows;
}

function affected(
  rows: readonly InvalidatedRow[],
  reason: ContextAffectedRecord["reason"],
): ContextAffectedRecord[] {
  return rows.map((row) => ({
    id: row.id,
    namespace: {
      workspaceId: row.workspaceId,
      scopeKind: row.scopeKind as ContextScopeKind,
      scopeId: row.scopeId,
    },
    sourceKind: row.sourceKind,
    sourceId: row.sourceId,
    version: row.version,
    reason,
  }));
}

function* bumpAffectedSteps(
  q: Q,
  records: readonly ContextAffectedRecord[],
  always: readonly ContextNamespace[],
  now: number,
) {
  const namespaces = new Map<string, ContextNamespace>();
  for (const namespace of [...always, ...records.map((record) => record.namespace)])
    namespaces.set(
      JSON.stringify([namespace.workspaceId, namespace.scopeKind, namespace.scopeId]),
      namespace,
    );
  const scopes: { namespace: ContextNamespace; generation: number }[] = [];
  for (const namespace of namespaces.values())
    scopes.push({ namespace, generation: yield* bumpScopeSteps(q, namespace, now) });
  return scopes;
}

function* evictOverCapSteps(q: Q, namespace: ContextNamespace, limits: ContextLimits, now: number) {
  const { contextRecord } = q.t;
  const evicted: InvalidatedRow[] = [];
  const caps = [
    {
      where: and(
        eq(contextRecord.workspaceId, namespace.workspaceId),
        eq(contextRecord.status, "current"),
      )!,
      cap: limits.workspaceCap,
    },
    {
      where: and(nsWhere(contextRecord, namespace), eq(contextRecord.status, "current"))!,
      cap: limits.scopeCap,
    },
  ];
  for (const { where, cap } of caps) {
    const over = yield* q.all(
      q.orm
        .select({ id: contextRecord.id })
        .from(contextRecord)
        .where(where)
        .orderBy(
          desc(contextRecord.importance),
          desc(contextRecord.observedAt),
          desc(contextRecord.id),
        )
        .offset(cap),
    );
    if (over.length === 0) continue;
    evicted.push(
      ...(yield* invalidateRowsSteps(
        q,
        inArray(
          contextRecord.id,
          over.map((row) => row.id),
        ),
        "retention",
        now,
      )),
    );
  }
  return evicted;
}

export type ContextIngest = {
  readonly namespace: ContextNamespace;
  readonly source: ContextSourceRevision;
  readonly claims: readonly ContextClaim[];
  readonly audience: string;
  readonly audienceLineage: string;
  readonly limits: ContextLimits;
  readonly now: number;
};

export function* ingestContextSourceSteps(q: Q, input: ContextIngest) {
  const { namespace, source, now } = input;
  const scope = yield* scopeStatusSteps(q, namespace);
  if (scope?.status === "disconnected") return { status: "disconnected" } as ContextIngestResult;
  const state = yield* sourceStateSteps(q, namespace, source);
  if (state?.status === "forgotten") return { status: "forgotten" } as ContextIngestResult;
  if (state?.blockedThrough != null && source.revisionAt <= state.blockedThrough)
    return { status: "stale" } as ContextIngestResult;
  if (state?.revisionAt != null && source.revisionAt < state.revisionAt)
    return { status: "stale" } as ContextIngestResult;

  const { contextRecord, contextSource } = q.t;
  const existing = yield* q.all(
    q.orm
      .select({
        id: contextRecord.id,
        recordKey: contextRecord.recordKey,
        version: contextRecord.version,
        status: contextRecord.status,
        contentHash: contextRecord.contentHash,
        correctedBy: contextRecord.correctedBy,
      })
      .from(contextRecord)
      .where(recordSourceWhere(q, namespace, source)),
  );
  const byKey = new Map<string, typeof existing>();
  for (const row of existing) byKey.set(row.recordKey, [...(byKey.get(row.recordKey) ?? []), row]);

  const expiresAt = now + input.limits.retentionMs;
  const provenance = {
    sourceUrl: source.url,
    sourceRevision: source.revision,
    sourceRevisionAt: source.revisionAt,
    restriction: source.restriction,
    audience: input.audience,
    audienceLineage: input.audienceLineage,
    expiresAt,
  };
  let inserted = 0;
  let refreshed = 0;
  let unchanged = 0;
  const superseded: ContextAffectedRecord[] = [];
  const seenKeys = new Set<string>();
  for (const claim of input.claims) {
    if (seenKeys.has(claim.key)) continue;
    seenKeys.add(claim.key);
    const hash = hashOf(claim.body);
    const rows = byKey.get(claim.key) ?? [];
    const current = rows.find((row) => row.status === "current");
    if (current?.contentHash === hash) {
      yield* q.exec(
        q.orm.update(contextRecord).set(provenance).where(eq(contextRecord.id, current.id)),
      );
      refreshed++;
      continue;
    }
    if (
      current?.correctedBy &&
      rows.some((row) => row.status === "superseded" && row.contentHash === hash)
    ) {
      unchanged++;
      continue;
    }
    if (current) {
      yield* q.exec(
        q.orm
          .update(contextRecord)
          .set({ status: "superseded", invalidatedAt: now })
          .where(eq(contextRecord.id, current.id)),
      );
      superseded.push({
        id: current.id,
        namespace,
        sourceKind: source.kind,
        sourceId: source.id,
        version: current.version,
        reason: "superseded",
      });
    }
    yield* q.exec(
      q.orm.insert(contextRecord).values({
        id: ulid(now),
        ...namespace,
        sourceKind: source.kind,
        sourceId: source.id,
        actorId: source.actorId,
        observedAt: now,
        recordKey: claim.key,
        layer: claim.layer,
        classification: claim.classification,
        importance: claim.importance,
        body: claim.body,
        bodyBytes: bytes(claim.body),
        contentHash: hash,
        version: Math.max(0, ...rows.map((row) => row.version)) + 1,
        status: "current",
        supersedes: current?.id ?? null,
        createdAt: now,
        ...provenance,
      }),
    );
    inserted++;
  }

  const removedKeys = [...byKey.keys()].filter((key) => !seenKeys.has(key));
  const edited =
    removedKeys.length === 0
      ? []
      : yield* invalidateRowsSteps(
          q,
          and(
            recordSourceWhere(q, namespace, source),
            inArray(contextRecord.recordKey, removedKeys),
          ),
          "edited",
          now,
        );

  yield* q.exec(
    q.orm
      .insert(contextSource)
      .values({
        ...namespace,
        sourceKind: source.kind,
        sourceId: source.id,
        status: "active",
        revision: source.revision,
        revisionAt: source.revisionAt,
        restriction: source.restriction,
        changedBy: source.actorId,
        changedAt: now,
        verifiedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          contextSource.workspaceId,
          contextSource.scopeKind,
          contextSource.scopeId,
          contextSource.sourceKind,
          contextSource.sourceId,
        ],
        set: {
          status: "active",
          revision: source.revision,
          revisionAt: source.revisionAt,
          restriction: source.restriction,
          changedBy: source.actorId,
          changedAt: now,
          verifiedAt: now,
        },
      }),
  );
  const evicted = yield* evictOverCapSteps(q, namespace, input.limits, now);
  const records = [...superseded, ...affected(edited, "edited"), ...affected(evicted, "retention")];
  const scopes = yield* bumpAffectedSteps(q, records, [namespace], now);
  yield* auditSteps(q, namespace, "ingest", source.actorId, source, now);
  return {
    status: "stored",
    inserted,
    refreshed,
    unchanged,
    invalidation: { scopes, records },
  } as ContextIngestResult;
}

export async function ingestContextSource(
  store: Db,
  input: ContextIngest,
): Promise<ContextIngestResult> {
  return store.transaction((q) => ingestContextSourceSteps(q, input));
}

export const contextRecordColumns = (q: Q) => {
  const r = q.t.contextRecord;
  return {
    id: r.id,
    workspaceId: r.workspaceId,
    scopeKind: r.scopeKind,
    scopeId: r.scopeId,
    sourceKind: r.sourceKind,
    sourceId: r.sourceId,
    sourceUrl: r.sourceUrl,
    sourceRevision: r.sourceRevision,
    sourceRevisionAt: r.sourceRevisionAt,
    actorId: r.actorId,
    observedAt: r.observedAt,
    recordKey: r.recordKey,
    layer: r.layer,
    classification: r.classification,
    importance: r.importance,
    body: r.body,
    bodyBytes: r.bodyBytes,
    audience: r.audience,
    audienceLineage: r.audienceLineage,
    restriction: r.restriction,
    version: r.version,
    status: r.status,
    supersedes: r.supersedes,
    correctedBy: r.correctedBy,
    invalidatedReason: r.invalidatedReason,
    expiresAt: r.expiresAt,
  };
};

export type RawContextRecord = Omit<
  ContextRecordRow,
  "namespace" | "layer" | "classification" | "restriction" | "status"
> & {
  workspaceId: string;
  scopeKind: string;
  scopeId: string;
  layer: string;
  classification: string;
  restriction: unknown;
  status: string;
};

export function contextRecordRow(row: RawContextRecord): ContextRecordRow {
  const { workspaceId, scopeKind, scopeId, ...rest } = row;
  return {
    ...rest,
    namespace: { workspaceId, scopeKind: scopeKind as ContextScopeKind, scopeId },
    layer: rest.layer as ContextLayer,
    classification: rest.classification as ContextClassification,
    restriction: (rest.restriction ?? {}) as ContextRestriction,
    status: rest.status as ContextRecordRow["status"],
  };
}

export type ContextCorrection = {
  readonly namespace: ContextNamespace;
  readonly recordId: string;
  readonly body: string;
  readonly classification?: ContextClassification;
  readonly actorId: string;
  readonly limits: ContextLimits;
  readonly now: number;
};

export function* getCurrentContextRecordSteps(
  q: Q,
  namespace: ContextNamespace,
  recordId: string,
  now: number,
) {
  const { contextRecord } = q.t;
  const row = yield* q.one(
    q.orm
      .select(contextRecordColumns(q))
      .from(contextRecord)
      .where(
        and(
          nsWhere(contextRecord, namespace),
          eq(contextRecord.id, recordId),
          eq(contextRecord.status, "current"),
          gt(contextRecord.expiresAt, now),
        ),
      ),
  );
  return row ? contextRecordRow(row) : null;
}

export function* correctContextRecordSteps(q: Q, input: ContextCorrection) {
  const old = yield* getCurrentContextRecordSteps(q, input.namespace, input.recordId, input.now);
  if (!old) return { status: "not_found" } as ContextCorrectionResult;
  const classification = input.classification ?? old.classification;
  if (classification === "decision" && old.classification !== "decision")
    return { status: "upgrade_refused" } as ContextCorrectionResult;
  const { contextRecord } = q.t;
  yield* q.exec(
    q.orm
      .update(contextRecord)
      .set({ status: "superseded", invalidatedAt: input.now })
      .where(eq(contextRecord.id, old.id)),
  );
  const id = ulid(input.now);
  yield* q.exec(
    q.orm.insert(contextRecord).values({
      id,
      ...input.namespace,
      sourceKind: old.sourceKind,
      sourceId: old.sourceId,
      sourceUrl: old.sourceUrl,
      sourceRevision: old.sourceRevision,
      sourceRevisionAt: old.sourceRevisionAt,
      actorId: input.actorId,
      observedAt: input.now,
      recordKey: old.recordKey,
      layer: old.layer,
      classification,
      importance: old.importance,
      body: input.body,
      bodyBytes: bytes(input.body),
      contentHash: hashOf(input.body),
      audience: old.audience,
      audienceLineage: old.audienceLineage,
      restriction: old.restriction,
      version: old.version + 1,
      status: "current",
      supersedes: old.id,
      correctedBy: input.actorId,
      expiresAt: input.now + input.limits.retentionMs,
      createdAt: input.now,
    }),
  );
  const record = (yield* getCurrentContextRecordSteps(q, input.namespace, id, input.now))!;
  const records: ContextAffectedRecord[] = [
    {
      id: old.id,
      namespace: input.namespace,
      sourceKind: old.sourceKind,
      sourceId: old.sourceId,
      version: old.version,
      reason: "superseded",
    },
  ];
  const scopes = yield* bumpAffectedSteps(q, [], [input.namespace], input.now);
  yield* auditSteps(
    q,
    input.namespace,
    "correct",
    input.actorId,
    { kind: old.sourceKind, id: old.sourceId },
    input.now,
  );
  return {
    status: "corrected",
    record,
    invalidation: { scopes, records },
  } as ContextCorrectionResult;
}

export async function correctContextRecord(
  store: Db,
  input: ContextCorrection,
): Promise<ContextCorrectionResult> {
  return store.transaction((q) => correctContextRecordSteps(q, input));
}

export type ContextVisibility = {
  readonly userId: string;
  readonly teamIds: readonly string[];
  readonly repositories: readonly string[];
  readonly channelIds: readonly string[];
  readonly audience: string;
  readonly audienceLineage: string;
};

export type ContextCandidateRead = {
  readonly namespace: ContextNamespace;
  readonly visibility: ContextVisibility;
  readonly now: number;
  readonly candidates: number;
  readonly preservedOnly?: boolean;
  readonly excludeCoveredBy?: readonly string[];
};

export function restrictionVisibleTo(
  visibility: Pick<ContextVisibility, "userId" | "teamIds" | "repositories" | "channelIds">,
) {
  const teams = JSON.stringify(visibility.teamIds);
  const repositories = JSON.stringify(visibility.repositories);
  const channels = JSON.stringify(visibility.channelIds);
  return and(
    sql`(restriction->'teamIds' IS NOT NULL OR restriction->>'repository' IS NOT NULL OR restriction->>'userId' IS NOT NULL OR restriction->>'channelId' IS NOT NULL)`,
    sql`(restriction->'teamIds' IS NULL OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(restriction->'teamIds') AS stored(id) JOIN jsonb_array_elements_text(${teams}::text::jsonb) AS granted(id) ON stored.id = granted.id))`,
    sql`(restriction->>'repository' IS NULL OR restriction->>'repository' IN (SELECT jsonb_array_elements_text(${repositories}::text::jsonb)))`,
    sql`(restriction->>'userId' IS NULL OR restriction->>'userId' = ${visibility.userId})`,
    sql`(restriction->>'channelId' IS NULL OR restriction->>'channelId' IN (SELECT jsonb_array_elements_text(${channels}::text::jsonb)))`,
  )!;
}

function visibleTo(q: Q, visibility: ContextVisibility) {
  const { contextRecord } = q.t;
  return and(
    eq(contextRecord.audience, visibility.audience),
    eq(contextRecord.audienceLineage, visibility.audienceLineage),
    restrictionVisibleTo(visibility),
  )!;
}

export function contextSourceVerified(q: Q) {
  const { contextRecord, contextSource } = q.t;
  return exists(
    q.orm
      .select({ one: contextSource.status })
      .from(contextSource)
      .where(
        and(
          eq(contextSource.workspaceId, contextRecord.workspaceId),
          eq(contextSource.scopeKind, contextRecord.scopeKind),
          eq(contextSource.scopeId, contextRecord.scopeId),
          eq(contextSource.sourceKind, contextRecord.sourceKind),
          eq(contextSource.sourceId, contextRecord.sourceId),
          eq(contextSource.status, "active"),
        ),
      ),
  );
}

export function* listContextCandidatesSteps(q: Q, input: ContextCandidateRead) {
  const scope = yield* scopeStatusSteps(q, input.namespace);
  if (!scope || scope.status !== "connected")
    return { generation: scope?.generation ?? 0, records: [] };
  const { contextRecord } = q.t;
  const rows = yield* q.all(
    q.orm
      .select(contextRecordColumns(q))
      .from(contextRecord)
      .where(
        and(
          nsWhere(contextRecord, input.namespace),
          eq(contextRecord.status, "current"),
          gt(contextRecord.expiresAt, input.now),
          visibleTo(q, input.visibility),
          contextSourceVerified(q),
          input.preservedOnly
            ? or(
                isNotNull(contextRecord.correctedBy),
                inArray(contextRecord.classification, [
                  "decision",
                  "unresolved_question",
                  "inference",
                ]),
              )
            : undefined,
          input.excludeCoveredBy?.length
            ? notExists(
                q.orm
                  .select({ one: q.t.contextSummarySource.recordId })
                  .from(q.t.contextSummarySource)
                  .where(
                    and(
                      inArray(q.t.contextSummarySource.summaryId, [...input.excludeCoveredBy]),
                      eq(q.t.contextSummarySource.recordId, contextRecord.id),
                    ),
                  ),
              )
            : undefined,
        ),
      )
      .orderBy(
        desc(contextRecord.importance),
        desc(contextRecord.observedAt),
        desc(contextRecord.id),
      )
      .limit(input.candidates),
  );
  return { generation: scope.generation, records: rows.map(contextRecordRow) };
}

export async function listContextCandidates(store: Db, input: ContextCandidateRead) {
  return store.run((q) => listContextCandidatesSteps(q, input));
}

export type ContextPageRead = {
  readonly namespace: ContextNamespace;
  readonly visibility: ContextVisibility;
  readonly now: number;
  readonly offset: number;
  readonly limit: number;
  readonly search?: string;
  readonly currentOnly?: boolean;
  readonly classifications?: readonly ContextClassification[];
  readonly sourceKinds?: readonly string[];
};

export async function listContextPage(store: Db, input: ContextPageRead) {
  return store.run(function* (q) {
    const scope = yield* scopeStatusSteps(q, input.namespace);
    if (!scope || scope.status !== "connected") return [] as ContextRecordRow[];
    const { contextRecord } = q.t;
    const search = input.search?.replace(/[\\%_]/g, (match) => `\\${match}`);
    const rows = yield* q.all(
      q.orm
        .select(contextRecordColumns(q))
        .from(contextRecord)
        .where(
          and(
            nsWhere(contextRecord, input.namespace),
            input.currentOnly
              ? eq(contextRecord.status, "current")
              : inArray(contextRecord.status, ["current", "superseded"]),
            gt(contextRecord.expiresAt, input.now),
            visibleTo(q, input.visibility),
            contextSourceVerified(q),
            search ? ilike(contextRecord.body, `%${search}%`) : undefined,
            input.classifications
              ? inArray(contextRecord.classification, [...input.classifications])
              : undefined,
            input.sourceKinds
              ? inArray(contextRecord.sourceKind, [...input.sourceKinds])
              : undefined,
          ),
        )
        .orderBy(desc(contextRecord.observedAt), desc(contextRecord.id))
        .offset(input.offset)
        .limit(input.limit),
    );
    return rows.map(contextRecordRow);
  });
}

export function* contextRecordHistorySteps(
  q: Q,
  namespace: ContextNamespace,
  recordId: string,
  max: number,
  now: number,
) {
  const { contextRecord } = q.t;
  const target = yield* q.one(
    q.orm
      .select(contextRecordColumns(q))
      .from(contextRecord)
      .where(
        and(
          nsWhere(contextRecord, namespace),
          eq(contextRecord.id, recordId),
          ne(contextRecord.status, "invalidated"),
          gt(contextRecord.expiresAt, now),
          contextSourceVerified(q),
        ),
      ),
  );
  if (!target) return null;
  const versions = yield* q.all(
    q.orm
      .select(contextRecordColumns(q))
      .from(contextRecord)
      .where(
        and(
          nsWhere(contextRecord, namespace),
          eq(contextRecord.sourceKind, target.sourceKind),
          eq(contextRecord.sourceId, target.sourceId),
          eq(contextRecord.recordKey, target.recordKey),
          ne(contextRecord.status, "invalidated"),
          gt(contextRecord.expiresAt, now),
        ),
      )
      .orderBy(desc(contextRecord.version))
      .limit(max),
  );
  return { record: contextRecordRow(target), versions: versions.map(contextRecordRow) };
}

export async function contextRecordHistory(
  store: Db,
  namespace: ContextNamespace,
  recordId: string,
  max: number,
  now: number,
) {
  return store.run((q) => contextRecordHistorySteps(q, namespace, recordId, max, now));
}

export function* contextSourceRestrictionSteps(
  q: Q,
  namespace: ContextNamespace,
  source: ContextSourceRef,
) {
  const state = yield* sourceStateSteps(q, namespace, source);
  return state
    ? { status: state.status, restriction: (state.restriction ?? {}) as ContextRestriction }
    : null;
}

export async function contextSourceRestriction(
  store: Db,
  namespace: ContextNamespace,
  source: ContextSourceRef,
) {
  return store.run((q) => contextSourceRestrictionSteps(q, namespace, source));
}

export type WorkItemProject = { id: string; name: string | null; items: number };

export async function listWorkItemProjects(store: Db, max: number): Promise<WorkItemProject[]> {
  return store.run(function* (q) {
    const { workItem } = q.t;
    const rows = yield* q.all(
      q.orm
        .select({
          id: workItem.linearProjectId,
          name: sql<
            string | null
          >`(array_agg(${workItem.linearProjectName} ORDER BY ${workItem.createdAt} DESC) FILTER (WHERE ${workItem.linearProjectName} IS NOT NULL))[1]`,
          items: count(),
        })
        .from(workItem)
        .where(isNotNull(workItem.linearProjectId))
        .groupBy(workItem.linearProjectId)
        .orderBy(asc(workItem.linearProjectId))
        .limit(max),
    );
    return rows.map((row) => ({ id: row.id!, name: row.name ?? null, items: Number(row.items) }));
  });
}

export type ContextSourceChange = {
  readonly namespace: ContextNamespace;
  readonly source: ContextSourceRef;
  readonly reason: "forgotten" | "deleted" | "revoked";
  readonly actorId: string | null;
  readonly now: number;
};

export function* invalidateContextSourceSteps(q: Q, input: ContextSourceChange) {
  const { namespace, source, reason, now } = input;
  const { contextSource } = q.t;
  const rows = yield* invalidateRowsSteps(q, recordSourceWhere(q, namespace, source), reason, now);
  const state = yield* sourceStateSteps(q, namespace, source);
  const through = Math.max(
    state?.blockedThrough ?? 0,
    state?.revisionAt ?? 0,
    ...rows.map((row) => row.sourceRevisionAt),
  );
  yield* q.exec(
    q.orm
      .insert(contextSource)
      .values({
        ...namespace,
        sourceKind: source.kind,
        sourceId: source.id,
        status: reason,
        blockedThrough: through,
        restriction: state?.restriction ?? {},
        changedBy: input.actorId,
        changedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          contextSource.workspaceId,
          contextSource.scopeKind,
          contextSource.scopeId,
          contextSource.sourceKind,
          contextSource.sourceId,
        ],
        set: { status: reason, blockedThrough: through, changedBy: input.actorId, changedAt: now },
      }),
  );
  const records = affected(rows, reason);
  const scopes = yield* bumpAffectedSteps(q, records, [namespace], now);
  yield* auditSteps(q, namespace, reason, input.actorId, source, now);
  return { scopes, records } as ContextInvalidation;
}

export async function invalidateContextSource(
  store: Db,
  input: ContextSourceChange,
): Promise<ContextInvalidation> {
  return store.transaction((q) => invalidateContextSourceSteps(q, input));
}

export function* readdContextSourceSteps(
  q: Q,
  input: { namespace: ContextNamespace; source: ContextSourceRef; actorId: string; now: number },
) {
  const { contextSource } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(contextSource)
      .set({
        status: "active",
        blockedThrough: null,
        revisionAt: null,
        changedBy: input.actorId,
        changedAt: input.now,
      })
      .where(and(sourceWhere(q, input.namespace, input.source), ne(contextSource.status, "active")))
      .returning({ status: contextSource.status }),
  );
  if (rows.length === 0) return false;
  yield* bumpScopeSteps(q, input.namespace, input.now);
  yield* auditSteps(q, input.namespace, "readd", input.actorId, input.source, input.now);
  return true;
}

export async function readdContextSource(
  store: Db,
  input: { namespace: ContextNamespace; source: ContextSourceRef; actorId: string; now: number },
): Promise<boolean> {
  return store.transaction((q) => readdContextSourceSteps(q, input));
}

export function* disconnectContextScopeSteps(
  q: Q,
  input: { namespace: ContextNamespace; actorId: string | null; now: number },
) {
  const { namespace, now } = input;
  const { contextRecord, contextScope, contextSource } = q.t;
  const rows = yield* invalidateRowsSteps(
    q,
    nsWhere(contextRecord, namespace),
    "disconnected",
    now,
  );
  yield* q.exec(
    q.orm
      .update(contextSource)
      .set({
        status: "disconnected",
        blockedThrough: sql`GREATEST(COALESCE(context_source.blocked_through, 0), COALESCE(context_source.revision_at, 0))`,
        changedAt: now,
      })
      .where(
        and(
          nsWhere(contextSource, namespace),
          inArray(contextSource.status, ["active", "unverified"]),
        ),
      ),
  );
  const generation = yield* bumpScopeSteps(q, namespace, now);
  yield* q.exec(
    q.orm
      .update(contextScope)
      .set({ status: "disconnected" })
      .where(nsWhere(contextScope, namespace)),
  );
  yield* auditSteps(q, namespace, "disconnect", input.actorId, null, now);
  return {
    scopes: [{ namespace, generation }],
    records: affected(rows, "disconnected"),
  } as ContextInvalidation;
}

export async function disconnectContextScope(
  store: Db,
  input: { namespace: ContextNamespace; actorId: string | null; now: number },
): Promise<ContextInvalidation> {
  return store.transaction((q) => disconnectContextScopeSteps(q, input));
}

export function* connectContextScopeSteps(
  q: Q,
  input: { namespace: ContextNamespace; actorId: string; now: number },
) {
  const { contextScope, contextSource } = q.t;
  const generation = yield* bumpScopeSteps(q, input.namespace, input.now);
  yield* q.exec(
    q.orm
      .update(contextScope)
      .set({ status: "connected" })
      .where(nsWhere(contextScope, input.namespace)),
  );
  yield* q.exec(
    q.orm
      .update(contextSource)
      .set({ status: "active", blockedThrough: null, revisionAt: null, changedAt: input.now })
      .where(
        and(nsWhere(contextSource, input.namespace), eq(contextSource.status, "disconnected")),
      ),
  );
  yield* auditSteps(q, input.namespace, "connect", input.actorId, null, input.now);
  return generation;
}

export async function connectContextScope(
  store: Db,
  input: { namespace: ContextNamespace; actorId: string; now: number },
): Promise<number> {
  return store.transaction((q) => connectContextScopeSteps(q, input));
}

export type ContextRetentionSweep = {
  readonly now: number;
  readonly historyMs: number;
  readonly batch: number;
};

export function* sweepContextRetentionSteps(q: Q, input: ContextRetentionSweep) {
  const { contextRecord } = q.t;
  const expired = yield* q.all(
    q.orm
      .select({ id: contextRecord.id })
      .from(contextRecord)
      .where(and(eq(contextRecord.status, "current"), lte(contextRecord.expiresAt, input.now)))
      .orderBy(asc(contextRecord.expiresAt))
      .limit(input.batch),
  );
  const rows =
    expired.length === 0
      ? []
      : yield* invalidateRowsSteps(
          q,
          inArray(
            contextRecord.id,
            expired.map((row) => row.id),
          ),
          "expired",
          input.now,
        );
  const records = affected(rows, "expired");
  const scopes = yield* bumpAffectedSteps(q, records, [], input.now);
  const purgeable = yield* q.all(
    q.orm
      .select({ id: contextRecord.id })
      .from(contextRecord)
      .where(
        and(
          inArray(contextRecord.status, ["superseded", "invalidated"]),
          lte(contextRecord.invalidatedAt, input.now - input.historyMs),
        ),
      )
      .limit(input.batch),
  );
  if (purgeable.length)
    yield* q.exec(
      q.orm.delete(contextRecord).where(
        inArray(
          contextRecord.id,
          purgeable.map((row) => row.id),
        ),
      ),
    );
  return { invalidation: { scopes, records } as ContextInvalidation, purged: purgeable.length };
}

export async function sweepContextRetention(store: Db, input: ContextRetentionSweep) {
  return store.transaction((q) => sweepContextRetentionSteps(q, input));
}

export function* listContextAuditSteps(q: Q, namespace: ContextNamespace, max: number) {
  const { contextAudit } = q.t;
  return yield* q.all(
    q.orm
      .select({
        action: contextAudit.action,
        actorId: contextAudit.actorId,
        sourceKind: contextAudit.sourceKind,
        sourceId: contextAudit.sourceId,
        at: contextAudit.at,
      })
      .from(contextAudit)
      .where(nsWhere(contextAudit, namespace))
      .orderBy(asc(contextAudit.at), asc(contextAudit.id))
      .limit(max),
  );
}

export async function listContextAudit(store: Db, namespace: ContextNamespace, max: number) {
  return store.run((q) => listContextAuditSteps(q, namespace, max));
}

export type ContextUnverifying = {
  readonly namespace: ContextNamespace;
  readonly sourceKinds: readonly string[];
  readonly exceptIds?: readonly string[];
  readonly onlyIds?: readonly string[];
  readonly verifiedBefore?: number;
  readonly now: number;
};

function idsIn(column: PgColumn, ids: readonly string[], negate: boolean) {
  const list = sql`(SELECT jsonb_array_elements_text(${JSON.stringify(ids)}::text::jsonb))`;
  return negate ? sql`${column} NOT IN ${list}` : sql`${column} IN ${list}`;
}

export function* markContextSourcesUnverifiedSteps(q: Q, input: ContextUnverifying) {
  const { contextRecord, contextSource } = q.t;
  if (input.onlyIds?.length === 0) return { scopes: [], records: [] } as ContextInvalidation;
  const sources = yield* q.all(
    q.orm
      .update(contextSource)
      .set({ status: "unverified", changedAt: input.now })
      .where(
        and(
          nsWhere(contextSource, input.namespace),
          inArray(contextSource.sourceKind, [...input.sourceKinds]),
          eq(contextSource.status, "active"),
          input.exceptIds?.length
            ? idsIn(contextSource.sourceId, input.exceptIds, true)
            : undefined,
          input.onlyIds ? idsIn(contextSource.sourceId, input.onlyIds, false) : undefined,
          input.verifiedBefore === undefined
            ? undefined
            : or(
                isNull(contextSource.verifiedAt),
                lt(contextSource.verifiedAt, input.verifiedBefore),
              ),
        ),
      )
      .returning({ sourceKind: contextSource.sourceKind, sourceId: contextSource.sourceId }),
  );
  if (sources.length === 0) return { scopes: [], records: [] } as ContextInvalidation;
  const records: ContextAffectedRecord[] = [];
  for (const kind of new Set(sources.map((source) => source.sourceKind))) {
    const rows = yield* q.all(
      q.orm
        .select({
          id: contextRecord.id,
          workspaceId: contextRecord.workspaceId,
          scopeKind: contextRecord.scopeKind,
          scopeId: contextRecord.scopeId,
          sourceKind: contextRecord.sourceKind,
          sourceId: contextRecord.sourceId,
          version: contextRecord.version,
          sourceRevisionAt: contextRecord.sourceRevisionAt,
        })
        .from(contextRecord)
        .where(
          and(
            nsWhere(contextRecord, input.namespace),
            eq(contextRecord.sourceKind, kind),
            inArray(
              contextRecord.sourceId,
              sources
                .filter((source) => source.sourceKind === kind)
                .map((source) => source.sourceId),
            ),
            eq(contextRecord.status, "current"),
          ),
        ),
    );
    records.push(...affected(rows, "unverified"));
  }
  const scopes = yield* bumpAffectedSteps(q, [], [input.namespace], input.now);
  yield* auditSteps(q, input.namespace, "unverified", null, null, input.now);
  return { scopes, records } as ContextInvalidation;
}

export async function markContextSourcesUnverified(
  store: Db,
  input: ContextUnverifying,
): Promise<ContextInvalidation> {
  return store.transaction((q) => markContextSourcesUnverifiedSteps(q, input));
}

export type ContextSourceCheckRead = {
  readonly namespace: ContextNamespace;
  readonly sourceKind: string;
  readonly exceptIds: readonly string[];
  readonly limit: number;
};

export function* listContextSourcesToCheckSteps(q: Q, input: ContextSourceCheckRead) {
  const { contextSource } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ sourceId: contextSource.sourceId })
      .from(contextSource)
      .where(
        and(
          nsWhere(contextSource, input.namespace),
          eq(contextSource.sourceKind, input.sourceKind),
          inArray(contextSource.status, ["active", "unverified"]),
          input.exceptIds.length ? idsIn(contextSource.sourceId, input.exceptIds, true) : undefined,
        ),
      )
      .orderBy(sql`${contextSource.verifiedAt} ASC NULLS FIRST`, asc(contextSource.sourceId))
      .limit(input.limit),
  );
  return rows.map((row) => row.sourceId);
}

export async function listContextSourcesToCheck(
  store: Db,
  input: ContextSourceCheckRead,
): Promise<string[]> {
  return store.run((q) => listContextSourcesToCheckSteps(q, input));
}
