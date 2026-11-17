import { and, eq, gt, inArray, sql } from "drizzle-orm";
import type { Db, Q } from "./db";
import {
  contextRecordColumns,
  contextRecordRow,
  contextSourceVerified,
  type ContextNamespace,
  type ContextRecordRow,
} from "./project-context";

export type ContextSessionRow = {
  consumerKey: string;
  namespace: ContextNamespace;
  requesterId: string;
  audience: string;
  version: number;
  generation: number;
  status: "injected" | "withheld";
  packHash: string;
  manifest: unknown;
  createdAt: number;
  updatedAt: number;
};

export type ContextSessionSave = {
  readonly consumerKey: string;
  readonly namespace: ContextNamespace;
  readonly requesterId: string;
  readonly audience: string;
  readonly generation: number;
  readonly status: ContextSessionRow["status"];
  readonly packHash: string;
  readonly manifest: unknown;
  readonly now: number;
};

export const CONTEXT_SESSION_RECORDS_MAX = 250;

function* readContextSessionSteps(q: Q, consumerKey: string) {
  const s = q.t.contextSession;
  const row = yield* q.one(q.orm.select().from(s).where(eq(s.consumerKey, consumerKey)));
  if (!row) return null;
  const { workspaceId, scopeKind, scopeId, ...rest } = row;
  return {
    ...rest,
    namespace: { workspaceId, scopeKind: scopeKind as ContextNamespace["scopeKind"], scopeId },
    status: rest.status as ContextSessionRow["status"],
  } satisfies ContextSessionRow;
}

export async function getContextSession(
  store: Db,
  consumerKey: string,
): Promise<ContextSessionRow | null> {
  return store.run((q) => readContextSessionSteps(q, consumerKey));
}

export function* saveContextSessionSteps(q: Q, input: ContextSessionSave) {
  const s = q.t.contextSession;
  const values = {
    workspaceId: input.namespace.workspaceId,
    scopeKind: input.namespace.scopeKind,
    scopeId: input.namespace.scopeId,
    requesterId: input.requesterId,
    audience: input.audience,
    generation: input.generation,
    status: input.status,
    packHash: input.packHash,
    manifest: input.manifest,
    updatedAt: input.now,
  };
  const row = yield* q.one(
    q.orm
      .insert(s)
      .values({ consumerKey: input.consumerKey, createdAt: input.now, version: 1, ...values })
      .onConflictDoUpdate({
        target: s.consumerKey,
        set: { ...values, version: sql`${s.version} + 1` },
      })
      .returning({ version: s.version }),
  );
  return row!.version;
}

export async function saveContextSession(store: Db, input: ContextSessionSave): Promise<number> {
  return store.transaction((q) => saveContextSessionSteps(q, input));
}

export function* currentContextRecordsSteps(
  q: Q,
  namespace: ContextNamespace,
  ids: readonly string[],
  now: number,
) {
  const unique = [...new Set(ids)].slice(0, CONTEXT_SESSION_RECORDS_MAX);
  if (unique.length === 0) return [] as ContextRecordRow[];
  const { contextRecord } = q.t;
  const rows = yield* q.all(
    q.orm
      .select(contextRecordColumns(q))
      .from(contextRecord)
      .where(
        and(
          eq(contextRecord.workspaceId, namespace.workspaceId),
          eq(contextRecord.scopeKind, namespace.scopeKind),
          eq(contextRecord.scopeId, namespace.scopeId),
          inArray(contextRecord.id, unique),
          eq(contextRecord.status, "current"),
          gt(contextRecord.expiresAt, now),
          contextSourceVerified(q),
        ),
      ),
  );
  return rows.map(contextRecordRow);
}

export async function currentContextRecords(
  store: Db,
  namespace: ContextNamespace,
  ids: readonly string[],
  now: number,
): Promise<ContextRecordRow[]> {
  return store.run((q) => currentContextRecordsSteps(q, namespace, ids, now));
}

export function* contextScopeGenerationSteps(q: Q, namespace: ContextNamespace) {
  const s = q.t.contextScope;
  const row = yield* q.one(
    q.orm
      .select({ generation: s.generation, status: s.status })
      .from(s)
      .where(
        and(
          eq(s.workspaceId, namespace.workspaceId),
          eq(s.scopeKind, namespace.scopeKind),
          eq(s.scopeId, namespace.scopeId),
        ),
      ),
  );
  return row ?? null;
}

export async function contextScopeGeneration(store: Db, namespace: ContextNamespace) {
  return store.run((q) => contextScopeGenerationSteps(q, namespace));
}
