import { createHash } from "node:crypto";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Db, Q } from "./db";
import {
  contextRecordColumns,
  contextRecordRow,
  contextSourceVerified,
  restrictionVisibleTo,
  type ContextNamespace,
  type ContextRecordRow,
  type ContextRestriction,
  type ContextVisibility,
} from "./project-context";
import { ulid } from "./ulid";

export type ContextSummaryRow = {
  id: string;
  namespace: ContextNamespace;
  partition: string;
  audience: string;
  audienceLineage: string;
  restriction: ContextRestriction;
  version: number;
  status: "empty" | "current" | "invalidated";
  body: string;
  bodyBytes: number;
  covered: number;
  watermark: number | null;
  generation: number | null;
  requestedAt: number | null;
  leaseToken: string | null;
  leaseUntil: number | null;
  attempts: number;
  failure: string | null;
  builtAt: number | null;
};

export type ContextSummaryView = ContextSummaryRow & { valid: boolean };

export type ContextLineageEntry = { readonly recordId: string; readonly version: number };

export type ContextSummaryPartition = {
  readonly namespace: ContextNamespace;
  readonly audience: string;
  readonly audienceLineage: string;
  readonly restriction: ContextRestriction;
};

function canonicalRestriction(restriction: ContextRestriction): string {
  const entries: [string, unknown][] = [];
  for (const key of ["teamIds", "repository", "ref", "userId", "channelId"] as const) {
    const value = restriction[key];
    if (value === undefined) continue;
    entries.push([key, Array.isArray(value) ? [...new Set(value)].sort() : value]);
  }
  return JSON.stringify(entries);
}

export function contextPartition(audienceLineage: string, restriction: ContextRestriction): string {
  return createHash("sha256")
    .update(`${audienceLineage}\0${canonicalRestriction(restriction)}`)
    .digest("hex")
    .slice(0, 40);
}

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

const summaryColumns = (q: Q) => {
  const s = q.t.contextSummary;
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    scopeKind: s.scopeKind,
    scopeId: s.scopeId,
    partition: s.partition,
    audience: s.audience,
    audienceLineage: s.audienceLineage,
    restriction: s.restriction,
    version: s.version,
    status: s.status,
    body: s.body,
    bodyBytes: s.bodyBytes,
    covered: s.covered,
    watermark: s.watermark,
    generation: s.generation,
    requestedAt: s.requestedAt,
    leaseToken: s.leaseToken,
    leaseUntil: s.leaseUntil,
    attempts: s.attempts,
    failure: s.failure,
    builtAt: s.builtAt,
  };
};

type RawSummary = Omit<ContextSummaryRow, "namespace" | "restriction" | "status"> & {
  workspaceId: string;
  scopeKind: string;
  scopeId: string;
  restriction: unknown;
  status: string;
};

function summaryRow(row: RawSummary): ContextSummaryRow {
  const { workspaceId, scopeKind, scopeId, ...rest } = row;
  return {
    ...rest,
    namespace: { workspaceId, scopeKind: scopeKind as ContextNamespace["scopeKind"], scopeId },
    restriction: (rest.restriction ?? {}) as ContextRestriction,
    status: rest.status as ContextSummaryRow["status"],
  };
}

function* validLineageCountSteps(
  q: Q,
  namespace: ContextNamespace,
  summaryId: string,
  partition: string,
  now: number,
) {
  const { contextRecord: r, contextSource: s, contextSummarySource: l } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ audienceLineage: r.audienceLineage, restriction: r.restriction })
      .from(l)
      .innerJoin(
        r,
        and(
          eq(r.id, l.recordId),
          eq(r.version, l.recordVersion),
          eq(r.status, "current"),
          gt(r.expiresAt, now),
          nsWhere(r, namespace),
        ),
      )
      .innerJoin(
        s,
        and(
          eq(s.workspaceId, r.workspaceId),
          eq(s.scopeKind, r.scopeKind),
          eq(s.scopeId, r.scopeId),
          eq(s.sourceKind, r.sourceKind),
          eq(s.sourceId, r.sourceId),
          eq(s.status, "active"),
        ),
      )
      .where(eq(l.summaryId, summaryId)),
  );
  return rows.filter(
    (row) =>
      contextPartition(row.audienceLineage, (row.restriction ?? {}) as ContextRestriction) ===
      partition,
  ).length;
}

export type ContextSummaryRead = {
  readonly namespace: ContextNamespace;
  readonly now: number;
  readonly partitions?: readonly string[];
  readonly visibility?: ContextVisibility;
  readonly limit?: number;
};

export function* listContextSummariesSteps(q: Q, input: ContextSummaryRead) {
  if (input.partitions?.length === 0) return [] as ContextSummaryView[];
  const { contextSummary } = q.t;
  const visibility = input.visibility;
  const rows = yield* q.all(
    q.orm
      .select(summaryColumns(q))
      .from(contextSummary)
      .where(
        and(
          nsWhere(contextSummary, input.namespace),
          input.partitions ? inArray(contextSummary.partition, [...input.partitions]) : undefined,
          visibility
            ? and(
                eq(contextSummary.status, "current"),
                eq(contextSummary.audience, visibility.audience),
                eq(contextSummary.audienceLineage, visibility.audienceLineage),
                restrictionVisibleTo(visibility),
              )
            : undefined,
        ),
      )
      .orderBy(desc(contextSummary.builtAt), contextSummary.id)
      .limit(input.limit ?? 64),
  );
  const views: ContextSummaryView[] = [];
  for (const raw of rows) {
    const row = summaryRow(raw);
    let valid = false;
    if (row.status === "current" && row.covered > 0)
      valid =
        (yield* validLineageCountSteps(q, input.namespace, row.id, row.partition, input.now)) ===
        row.covered;
    views.push({ ...row, valid });
  }
  return views;
}

export async function listContextSummaries(
  store: Db,
  input: ContextSummaryRead,
): Promise<ContextSummaryView[]> {
  return store.run((q) => listContextSummariesSteps(q, input));
}

export function* contextSummaryLineageSteps(q: Q, summaryId: string, max: number) {
  const { contextSummarySource } = q.t;
  return (yield* q.all(
    q.orm
      .select({
        recordId: contextSummarySource.recordId,
        version: contextSummarySource.recordVersion,
      })
      .from(contextSummarySource)
      .where(eq(contextSummarySource.summaryId, summaryId))
      .orderBy(contextSummarySource.recordId)
      .limit(max),
  )) as ContextLineageEntry[];
}

export async function contextSummaryLineage(
  store: Db,
  summaryId: string,
  max: number,
): Promise<ContextLineageEntry[]> {
  return store.run((q) => contextSummaryLineageSteps(q, summaryId, max));
}

export type ContextCompactionRequest = ContextSummaryPartition & {
  readonly now: number;
  readonly retryAfterMs: number;
};

export function* requestContextCompactionSteps(q: Q, input: ContextCompactionRequest) {
  const { contextSummary } = q.t;
  const partition = contextPartition(input.audienceLineage, input.restriction);
  const inserted = yield* q.all(
    q.orm
      .insert(contextSummary)
      .values({
        id: ulid(input.now),
        ...input.namespace,
        partition,
        audience: input.audience,
        audienceLineage: input.audienceLineage,
        restriction: input.restriction,
        version: 1,
        status: "empty",
        body: "",
        bodyBytes: 0,
        covered: 0,
        requestedAt: input.now,
        attempts: 0,
        changedAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ id: contextSummary.id }),
  );
  if (inserted.length) return "requested" as const;
  const updated = yield* q.all(
    q.orm
      .update(contextSummary)
      .set({
        requestedAt: input.now,
        version: sql`${contextSummary.version} + 1`,
        changedAt: input.now,
      })
      .where(
        and(
          nsWhere(contextSummary, input.namespace),
          eq(contextSummary.partition, partition),
          isNull(contextSummary.requestedAt),
          or(
            isNull(contextSummary.failure),
            lte(contextSummary.changedAt, input.now - input.retryAfterMs),
          ),
        ),
      )
      .returning({ id: contextSummary.id }),
  );
  if (updated.length) return "requested" as const;
  const pending = yield* q.one(
    q.orm
      .select({ requestedAt: contextSummary.requestedAt })
      .from(contextSummary)
      .where(
        and(nsWhere(contextSummary, input.namespace), eq(contextSummary.partition, partition)),
      ),
  );
  return pending?.requestedAt != null ? ("coalesced" as const) : ("backing_off" as const);
}

export async function requestContextCompaction(
  store: Db,
  input: ContextCompactionRequest,
): Promise<"requested" | "coalesced" | "backing_off"> {
  return store.transaction((q) => requestContextCompactionSteps(q, input));
}

export type ContextRequestedCompactionRead = {
  readonly namespace: ContextNamespace;
  readonly visibility: ContextVisibility;
  readonly now: number;
  readonly limit: number;
};

export function* listRequestedContextCompactionsSteps(q: Q, input: ContextRequestedCompactionRead) {
  const { contextSummary } = q.t;
  const rows = yield* q.all(
    q.orm
      .select(summaryColumns(q))
      .from(contextSummary)
      .where(
        and(
          nsWhere(contextSummary, input.namespace),
          eq(contextSummary.audience, input.visibility.audience),
          eq(contextSummary.audienceLineage, input.visibility.audienceLineage),
          restrictionVisibleTo(input.visibility),
          isNotNull(contextSummary.requestedAt),
          or(isNull(contextSummary.leaseUntil), lte(contextSummary.leaseUntil, input.now)),
        ),
      )
      .orderBy(contextSummary.requestedAt)
      .limit(input.limit),
  );
  return rows.map(summaryRow);
}

export async function listRequestedContextCompactions(
  store: Db,
  input: ContextRequestedCompactionRead,
): Promise<ContextSummaryRow[]> {
  return store.run((q) => listRequestedContextCompactionsSteps(q, input));
}

export type ContextSummaryDeltaRead = {
  readonly namespace: ContextNamespace;
  readonly summaryId: string;
  readonly restriction: ContextRestriction;
  readonly visibility: ContextVisibility;
  readonly excludeCovered: boolean;
  readonly now: number;
  readonly limit: number;
};

export function* listContextSummaryDeltaSteps(q: Q, input: ContextSummaryDeltaRead) {
  const { contextRecord: r, contextSummarySource: l } = q.t;
  const restriction = JSON.stringify(input.restriction);
  const rows = yield* q.all(
    q.orm
      .select(contextRecordColumns(q))
      .from(r)
      .where(
        and(
          nsWhere(r, input.namespace),
          eq(r.status, "current"),
          gt(r.expiresAt, input.now),
          eq(r.audience, input.visibility.audience),
          eq(r.audienceLineage, input.visibility.audienceLineage),
          sql`${r.restriction} @> ${restriction}::text::jsonb`,
          sql`${r.restriction} <@ ${restriction}::text::jsonb`,
          restrictionVisibleTo(input.visibility),
          contextSourceVerified(q),
          isNull(r.correctedBy),
          or(
            eq(r.layer, "source_text"),
            and(
              eq(r.layer, "observation"),
              inArray(r.classification, ["reported_fact", "verified_fact"]),
            ),
          ),
          input.excludeCovered
            ? notExists(
                q.orm
                  .select({ one: l.recordId })
                  .from(l)
                  .where(and(eq(l.summaryId, input.summaryId), eq(l.recordId, r.id))),
              )
            : undefined,
        ),
      )
      .orderBy(desc(r.importance), desc(r.observedAt), desc(r.id))
      .limit(input.limit),
  );
  return rows.map(contextRecordRow);
}

export async function listContextSummaryDelta(
  store: Db,
  input: ContextSummaryDeltaRead,
): Promise<ContextRecordRow[]> {
  return store.run((q) => listContextSummaryDeltaSteps(q, input));
}

export type ContextCompactionClaim = {
  readonly namespace: ContextNamespace;
  readonly summaryId: string;
  readonly leaseToken: string;
  readonly leaseMs: number;
  readonly now: number;
};

export function* claimContextCompactionSteps(q: Q, input: ContextCompactionClaim) {
  const { contextSummary } = q.t;
  const row = yield* q.one(
    q.orm
      .update(contextSummary)
      .set({
        leaseToken: input.leaseToken,
        leaseUntil: input.now + input.leaseMs,
        claimedAt: input.now,
        attempts: sql`${contextSummary.attempts} + 1`,
        version: sql`${contextSummary.version} + 1`,
        changedAt: input.now,
      })
      .where(
        and(
          nsWhere(contextSummary, input.namespace),
          eq(contextSummary.id, input.summaryId),
          isNotNull(contextSummary.requestedAt),
          or(isNull(contextSummary.leaseUntil), lte(contextSummary.leaseUntil, input.now)),
        ),
      )
      .returning(summaryColumns(q)),
  );
  return row ? summaryRow(row) : null;
}

export async function claimContextCompaction(
  store: Db,
  input: ContextCompactionClaim,
): Promise<ContextSummaryRow | null> {
  return store.transaction((q) => claimContextCompactionSteps(q, input));
}

type LineageCheck = {
  readonly namespace: ContextNamespace;
  readonly partition: string;
  readonly lineage: readonly ContextLineageEntry[];
  readonly now: number;
  readonly lock: boolean;
};

function* lineageCurrentSteps(q: Q, input: LineageCheck) {
  if (input.lineage.length === 0) return true;
  const { contextRecord: r, contextSource: s } = q.t;
  const ids = [...new Set(input.lineage.map((entry) => entry.recordId))];
  if (ids.length !== input.lineage.length) return false;
  const query = q.orm
    .select({
      id: r.id,
      version: r.version,
      status: r.status,
      expiresAt: r.expiresAt,
      audienceLineage: r.audienceLineage,
      restriction: r.restriction,
      sourceKind: r.sourceKind,
      sourceId: r.sourceId,
    })
    .from(r)
    .where(and(nsWhere(r, input.namespace), inArray(r.id, ids)));
  const rows = yield* q.all(input.lock ? query.for("share") : query);
  if (rows.length !== ids.length) return false;
  const versions = new Map(input.lineage.map((entry) => [entry.recordId, entry.version]));
  for (const row of rows)
    if (
      row.status !== "current" ||
      row.version !== versions.get(row.id) ||
      row.expiresAt <= input.now ||
      contextPartition(row.audienceLineage, (row.restriction ?? {}) as ContextRestriction) !==
        input.partition
    )
      return false;
  const sourceKeys = new Set(rows.map((row) => JSON.stringify([row.sourceKind, row.sourceId])));
  const sourceQuery = q.orm
    .select({ kind: s.sourceKind, id: s.sourceId, status: s.status })
    .from(s)
    .where(
      and(
        nsWhere(s, input.namespace),
        inArray(
          s.sourceId,
          rows.map((row) => row.sourceId),
        ),
      ),
    );
  const sources = yield* q.all(input.lock ? sourceQuery.for("share") : sourceQuery);
  const active = new Set(
    sources
      .filter((source) => source.status === "active")
      .map((source) => JSON.stringify([source.kind, source.id])),
  );
  for (const key of sourceKeys) if (!active.has(key)) return false;
  const scope = yield* q.one(
    q.orm
      .select({ status: q.t.contextScope.status })
      .from(q.t.contextScope)
      .where(nsWhere(q.t.contextScope, input.namespace)),
  );
  return scope?.status === "connected";
}

export async function contextLineageCurrent(
  store: Db,
  input: Omit<LineageCheck, "lock">,
): Promise<boolean> {
  return store.run((q) => lineageCurrentSteps(q, { ...input, lock: false }));
}

export type ContextSummaryPublish = {
  readonly namespace: ContextNamespace;
  readonly summaryId: string;
  readonly leaseToken: string;
  readonly version: number;
  readonly body: string;
  readonly lineage: readonly ContextLineageEntry[];
  readonly watermark: number;
  readonly now: number;
};

export type ContextSummaryPublishResult =
  | { status: "published"; version: number }
  | { status: "conflict" | "invalidated" };

export function* publishContextSummarySteps(q: Q, input: ContextSummaryPublish) {
  const { contextSummary, contextSummarySource, contextScope } = q.t;
  const held = yield* q.one(
    q.orm
      .select({ partition: contextSummary.partition })
      .from(contextSummary)
      .where(
        and(
          nsWhere(contextSummary, input.namespace),
          eq(contextSummary.id, input.summaryId),
          eq(contextSummary.leaseToken, input.leaseToken),
          eq(contextSummary.version, input.version),
        ),
      )
      .for("update"),
  );
  if (!held) return { status: "conflict" } as ContextSummaryPublishResult;
  const current =
    input.lineage.length > 0 &&
    (yield* lineageCurrentSteps(q, {
      namespace: input.namespace,
      partition: held.partition,
      lineage: input.lineage,
      now: input.now,
      lock: true,
    }));
  if (!current) {
    yield* q.exec(
      q.orm
        .update(contextSummary)
        .set({
          leaseToken: null,
          leaseUntil: null,
          requestedAt: null,
          failure: "lineage_changed",
          version: input.version + 1,
          changedAt: input.now,
        })
        .where(eq(contextSummary.id, input.summaryId)),
    );
    return { status: "invalidated" } as ContextSummaryPublishResult;
  }
  const scope = yield* q.one(
    q.orm
      .select({ generation: contextScope.generation })
      .from(contextScope)
      .where(nsWhere(contextScope, input.namespace)),
  );
  yield* q.exec(
    q.orm.delete(contextSummarySource).where(eq(contextSummarySource.summaryId, input.summaryId)),
  );
  for (let start = 0; start < input.lineage.length; start += 500)
    yield* q.exec(
      q.orm.insert(contextSummarySource).values(
        input.lineage.slice(start, start + 500).map((entry) => ({
          summaryId: input.summaryId,
          recordId: entry.recordId,
          recordVersion: entry.version,
        })),
      ),
    );
  const version = input.version + 1;
  yield* q.exec(
    q.orm
      .update(contextSummary)
      .set({
        status: "current",
        body: input.body,
        bodyBytes: Buffer.byteLength(input.body, "utf8"),
        covered: input.lineage.length,
        watermark: input.watermark,
        generation: scope?.generation ?? 0,
        requestedAt: null,
        leaseToken: null,
        leaseUntil: null,
        attempts: 0,
        failure: null,
        builtAt: input.now,
        version,
        changedAt: input.now,
      })
      .where(eq(contextSummary.id, input.summaryId)),
  );
  return { status: "published", version } as ContextSummaryPublishResult;
}

export async function publishContextSummary(
  store: Db,
  input: ContextSummaryPublish,
): Promise<ContextSummaryPublishResult> {
  return store.transaction((q) => publishContextSummarySteps(q, input));
}

export function* releaseContextCompactionSteps(
  q: Q,
  input: {
    namespace: ContextNamespace;
    summaryId: string;
    leaseToken: string;
    version: number;
    failure: string;
    now: number;
  },
) {
  const { contextSummary } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(contextSummary)
      .set({
        leaseToken: null,
        leaseUntil: null,
        requestedAt: null,
        failure: input.failure,
        version: input.version + 1,
        changedAt: input.now,
      })
      .where(
        and(
          nsWhere(contextSummary, input.namespace),
          eq(contextSummary.id, input.summaryId),
          eq(contextSummary.leaseToken, input.leaseToken),
          eq(contextSummary.version, input.version),
        ),
      )
      .returning({ id: contextSummary.id }),
  );
  return rows.length > 0;
}

export async function releaseContextCompaction(
  store: Db,
  input: {
    namespace: ContextNamespace;
    summaryId: string;
    leaseToken: string;
    version: number;
    failure: string;
    now: number;
  },
): Promise<boolean> {
  return store.transaction((q) => releaseContextCompactionSteps(q, input));
}

export function* clearDependentContextSummariesSteps(
  q: Q,
  recordIds: readonly string[],
  now: number,
) {
  if (recordIds.length === 0) return 0;
  const { contextSummary, contextSummarySource } = q.t;
  const summaryIds = new Set<string>();
  for (let start = 0; start < recordIds.length; start += 1000) {
    const rows = yield* q.all(
      q.orm
        .selectDistinct({ summaryId: contextSummarySource.summaryId })
        .from(contextSummarySource)
        .where(inArray(contextSummarySource.recordId, recordIds.slice(start, start + 1000))),
    );
    for (const row of rows) summaryIds.add(row.summaryId);
  }
  if (summaryIds.size === 0) return 0;
  const ids = [...summaryIds];
  yield* q.exec(
    q.orm
      .update(contextSummary)
      .set({
        status: "invalidated",
        body: "",
        bodyBytes: 0,
        covered: 0,
        watermark: null,
        version: sql`${contextSummary.version} + 1`,
        changedAt: now,
      })
      .where(inArray(contextSummary.id, ids)),
  );
  yield* q.exec(
    q.orm.delete(contextSummarySource).where(inArray(contextSummarySource.summaryId, ids)),
  );
  return ids.length;
}
