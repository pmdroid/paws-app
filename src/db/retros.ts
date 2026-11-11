import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray, max, notInArray, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps, type Db } from "./db";
import { recordImprovementProposalSteps, type ImprovementActionStep } from "./improvements";
import { jsonValue } from "./json-text";
import type * as pgSchema from "./schema-pg";
import { ulid } from "./ulid";

export type RetroState =
  | "collecting"
  | "queued"
  | "generating"
  | "failed"
  | "published"
  | "abandoned"
  | "coverage_failed";
export type RetroOrigin = "scheduled" | "manual";
export type RetroArtifactKind = "digest" | "manifest" | "prompt" | "report";
export type RetroCoverageGapKind =
  | "missing_artifact"
  | "hash_mismatch"
  | "retention_gap"
  | "source_unavailable";

export type RetroSettings = {
  prompt: string;
  agentProfile: Record<string, unknown>;
  repositories: string[];
  outputLimits: Record<string, unknown>;
  executionLimits: Record<string, unknown>;
  schedule: Record<string, unknown>;
};

export type RetroSettingsRevision = RetroSettings & {
  workspaceId: string;
  revision: number;
  createdBy: string;
  createdAt: number;
};

export type Retro = {
  id: string;
  workspaceId: string;
  windowStart: number;
  windowEnd: number;
  origin: RetroOrigin;
  scheduledFor: number | null;
  settingsRevision: number;
  prompt: string;
  agentProfile: Record<string, unknown>;
  repositories: string[];
  outputLimits: Record<string, unknown>;
  executionLimits: Record<string, unknown>;
  state: RetroState;
  digestSha256: string | null;
  manifestSha256: string | null;
  attempt: number;
  owner: string | null;
  ownerExpiresAt: number | null;
  result: unknown;
  resultSha256: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
};

export type RetroRepositoryCursor = {
  repository: string;
  startCursor: number;
  endCursor: number | null;
};

export type RetroEvidence = {
  evidenceId: string;
  repository: string;
  sourceKind: string;
  sourceRef: string;
  occurredAt: number;
  excerpt: string;
};

export type RetroCoverageGap = {
  repository: string | null;
  kind: RetroCoverageGapKind;
  detail: string;
  recordedAt: number;
};

export type RetroAttempt = {
  attempt: number;
  owner: string;
  startedAt: number;
  leaseExpiresAt: number;
  finishedAt: number | null;
  outcome: "running" | "failed" | "expired" | "succeeded";
  error: string | null;
};

export type RetroItemInput = {
  itemId: string;
  repository: string;
  area: string;
  actionStep: ImprovementActionStep;
  title: string;
  problem: string;
  proposedChange: string;
  verificationCriterion: string;
  evidenceIds: string[];
};

export type RetroItem = RetroItemInput & {
  retroId: string;
  position: number;
  improvementId: string;
};

export type RetroArtifactRecord = {
  kind: RetroArtifactKind;
  sha256: string;
  sizeBytes: number;
  fileName: string;
  createdAt: number;
};

export type RetroArtifactRead =
  | { ok: true; bytes: Uint8Array; artifact: RetroArtifactRecord }
  | { ok: false; reason: "unrecorded" | "missing_artifact" | "hash_mismatch" };

export type RetroScheduleRuntime = typeof pgSchema.retroScheduleRuntime.$inferSelect;

export const newRetroId = (now: number): string => ulid(now);

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function jsonOut<T>(q: Q, stored: unknown): T {
  return (q.dialect === "sqlite" ? JSON.parse(stored as string) : stored) as T;
}

type SettingsInput = RetroSettings & { workspaceId: string; createdBy: string; now: number };

export function saveRetroSettingsRevision(
  db: Database,
  input: SettingsInput,
): RetroSettingsRevision {
  return settled(sqliteDb(db).transaction((q) => saveRetroSettingsRevisionSteps(q, input)));
}

export function* saveRetroSettingsRevisionSteps(q: Q, input: SettingsInput) {
  const { retroSettingsRevision: settings } = q.t;
  const latest = yield* q.one(
    q.orm
      .select({ revision: max(settings.revision) })
      .from(settings)
      .where(eq(settings.workspaceId, input.workspaceId)),
  );
  const revision = (latest?.revision ?? 0) + 1;
  yield* q.exec(
    q.orm.insert(settings).values({
      workspaceId: input.workspaceId,
      revision,
      prompt: input.prompt,
      agentProfile: jsonValue(q, input.agentProfile),
      repositories: jsonValue(q, input.repositories),
      outputLimits: jsonValue(q, input.outputLimits),
      executionLimits: jsonValue(q, input.executionLimits),
      schedule: jsonValue(q, input.schedule),
      createdBy: input.createdBy,
      createdAt: input.now,
    }),
  );
  return (yield* getRetroSettingsRevisionSteps(q, input.workspaceId, revision))!;
}

type SettingsRow = typeof pgSchema.retroSettingsRevision.$inferSelect;

function settingsFromRow(q: Q, row: SettingsRow): RetroSettingsRevision {
  return {
    workspaceId: row.workspaceId,
    revision: row.revision,
    prompt: row.prompt,
    agentProfile: jsonOut(q, row.agentProfile),
    repositories: jsonOut(q, row.repositories),
    outputLimits: jsonOut(q, row.outputLimits),
    executionLimits: jsonOut(q, row.executionLimits),
    schedule: jsonOut(q, row.schedule),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export async function getRetroSettingsRevision(
  store: Db,
  workspaceId: string,
  revision: number,
): Promise<RetroSettingsRevision | null> {
  return store.run((q) => getRetroSettingsRevisionSteps(q, workspaceId, revision));
}

export function* getRetroSettingsRevisionSteps(q: Q, workspaceId: string, revision: number) {
  const { retroSettingsRevision: settings } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(settings)
      .where(and(eq(settings.workspaceId, workspaceId), eq(settings.revision, revision))),
  );
  return row === undefined ? null : settingsFromRow(q, row);
}

export async function latestRetroSettingsRevision(
  store: Db,
  workspaceId: string,
): Promise<RetroSettingsRevision | null> {
  return store.run((q) => latestRetroSettingsRevisionSteps(q, workspaceId));
}

export function* latestRetroSettingsRevisionSteps(q: Q, workspaceId: string) {
  const { retroSettingsRevision: settings } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(settings)
      .where(eq(settings.workspaceId, workspaceId))
      .orderBy(desc(settings.revision))
      .limit(1),
  );
  return row === undefined ? null : settingsFromRow(q, row);
}

type RetroRow = typeof pgSchema.retro.$inferSelect;

function retroFromRow(q: Q, row: RetroRow): Retro {
  return {
    ...row,
    origin: row.origin as RetroOrigin,
    agentProfile: jsonOut(q, row.agentProfile),
    repositories: jsonOut(q, row.repositories),
    outputLimits: jsonOut(q, row.outputLimits),
    executionLimits: jsonOut(q, row.executionLimits),
    state: row.state as RetroState,
    result: row.result === null ? null : jsonOut(q, row.result),
  };
}

export async function getRetro(store: Db, id: string): Promise<Retro | null> {
  return store.run((q) => getRetroSteps(q, id));
}

export function* getRetroSteps(q: Q, id: string) {
  const row = yield* q.one(q.orm.select().from(q.t.retro).where(eq(q.t.retro.id, id)));
  return row === undefined ? null : retroFromRow(q, row);
}

export async function listRetros(store: Db, workspaceId: string): Promise<Retro[]> {
  return store.run((q) => listRetrosSteps(q, workspaceId));
}

export function* listRetrosSteps(q: Q, workspaceId: string) {
  const { retro } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(retro)
      .where(eq(retro.workspaceId, workspaceId))
      .orderBy(desc(retro.windowEnd), retro.id),
  );
  return rows.map((row) => retroFromRow(q, row));
}

type NewRetro = {
  id: string;
  workspaceId: string;
  windowStart: number;
  windowEnd: number;
  origin: RetroOrigin;
  scheduledFor?: number;
  settingsRevision: number;
  agentProfile?: Record<string, unknown>;
  repositories?: string[];
  now: number;
};

export function createRetro(db: Database, input: NewRetro): { retro: Retro; created: boolean } {
  return settled(sqliteDb(db).transaction((q) => createRetroSteps(q, input)));
}

export function* createRetroSteps(q: Q, input: NewRetro) {
  const { retro } = q.t;
  const existing = yield* q.one(
    q.orm
      .select()
      .from(retro)
      .where(
        and(
          eq(retro.workspaceId, input.workspaceId),
          eq(retro.windowStart, input.windowStart),
          eq(retro.windowEnd, input.windowEnd),
        ),
      ),
  );
  if (existing !== undefined) return { retro: retroFromRow(q, existing), created: false };
  const settings = yield* getRetroSettingsRevisionSteps(
    q,
    input.workspaceId,
    input.settingsRevision,
  );
  if (settings === null)
    throw new Error(`Unknown retro settings revision ${input.settingsRevision}`);
  const allowed = new Set(settings.repositories.map((name) => name.toLowerCase()));
  const repositories = input.repositories ?? settings.repositories;
  if (repositories.some((name) => !allowed.has(name.toLowerCase())))
    throw new Error(`Retro repositories must come from settings revision ${settings.revision}`);
  yield* q.exec(
    q.orm.insert(retro).values({
      id: input.id,
      workspaceId: input.workspaceId,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      origin: input.origin,
      scheduledFor: input.scheduledFor ?? null,
      settingsRevision: settings.revision,
      prompt: settings.prompt,
      agentProfile: jsonValue(q, input.agentProfile ?? settings.agentProfile),
      repositories: jsonValue(q, repositories),
      outputLimits: jsonValue(q, settings.outputLimits),
      executionLimits: jsonValue(q, settings.executionLimits),
      state: "collecting",
      createdAt: input.now,
      updatedAt: input.now,
    }),
  );
  return { retro: (yield* getRetroSteps(q, input.id))!, created: true };
}

export async function retroRepositories(
  store: Db,
  retroId: string,
): Promise<RetroRepositoryCursor[]> {
  return store.run((q) => retroRepositoriesSteps(q, retroId));
}

export function* retroRepositoriesSteps(q: Q, retroId: string) {
  const { retroRepository } = q.t;
  return yield* q.all(
    q.orm
      .select({
        repository: retroRepository.repository,
        startCursor: retroRepository.startCursor,
        endCursor: retroRepository.endCursor,
      })
      .from(retroRepository)
      .where(eq(retroRepository.retroId, retroId))
      .orderBy(retroRepository.repository),
  );
}

export async function retroWatermarks(
  store: Db,
  workspaceId: string,
): Promise<{ repository: string; cursor: number; retroId: string; updatedAt: number }[]> {
  return store.run((q) => retroWatermarksSteps(q, workspaceId));
}

export function* retroWatermarksSteps(q: Q, workspaceId: string) {
  const { retroWatermark } = q.t;
  return yield* q.all(
    q.orm
      .select({
        repository: retroWatermark.repository,
        cursor: retroWatermark.cursor,
        retroId: retroWatermark.retroId,
        updatedAt: retroWatermark.updatedAt,
      })
      .from(retroWatermark)
      .where(eq(retroWatermark.workspaceId, workspaceId))
      .orderBy(retroWatermark.repository),
  );
}

type Collection = { retroId: string; initialCursors?: Record<string, number>; now: number };
type CollectionStart =
  | { ok: true; repositories: RetroRepositoryCursor[] }
  | { ok: false; reason: "not_collecting" }
  | { ok: false; reason: "busy"; busy: { repository: string; retroId: string }[] };

export function beginRetroCollection(db: Database, input: Collection): CollectionStart {
  return settled(sqliteDb(db).transaction((q) => beginRetroCollectionSteps(q, input)));
}

export function* beginRetroCollectionSteps(q: Q, input: Collection) {
  const { retroCollectionLock: lock, retroWatermark: watermark, retroRepository } = q.t;
  const retro = yield* getRetroSteps(q, input.retroId);
  if (retro === null || retro.state !== "collecting")
    return { ok: false, reason: "not_collecting" } as CollectionStart;
  const busy: { repository: string; retroId: string }[] = [];
  for (const repository of retro.repositories) {
    const holder = yield* q.one(
      q.orm
        .select({ retroId: lock.retroId })
        .from(lock)
        .where(and(eq(lock.workspaceId, retro.workspaceId), eq(lock.repository, repository))),
    );
    if (holder !== undefined && holder.retroId !== retro.id)
      busy.push({ repository, retroId: holder.retroId });
  }
  if (busy.length > 0) return { ok: false, reason: "busy", busy } as CollectionStart;
  for (const repository of retro.repositories) {
    yield* q.exec(
      q.orm
        .insert(lock)
        .values({
          workspaceId: retro.workspaceId,
          repository,
          retroId: retro.id,
          acquiredAt: input.now,
        })
        .onConflictDoNothing(),
    );
    const stored = yield* q.one(
      q.orm
        .select({ cursor: watermark.cursor })
        .from(watermark)
        .where(
          and(eq(watermark.workspaceId, retro.workspaceId), eq(watermark.repository, repository)),
        ),
    );
    yield* q.exec(
      q.orm
        .insert(retroRepository)
        .values({
          retroId: retro.id,
          repository,
          startCursor: stored?.cursor ?? input.initialCursors?.[repository] ?? 0,
        })
        .onConflictDoNothing(),
    );
  }
  return {
    ok: true,
    repositories: yield* retroRepositoriesSteps(q, retro.id),
  } as CollectionStart;
}

export function recordRetroEvidence(
  db: Database,
  retroId: string,
  evidence: RetroEvidence[],
): void {
  settled(sqliteDb(db).transaction((q) => recordRetroEvidenceSteps(q, retroId, evidence)));
}

export function* recordRetroEvidenceSteps(q: Q, retroId: string, evidence: RetroEvidence[]) {
  const { retroEvidence } = q.t;
  if ((yield* getRetroSteps(q, retroId))?.state !== "collecting")
    throw new Error(`Retro ${retroId} is not collecting evidence`);
  for (const entry of evidence) {
    const inserted = yield* q.all(
      q.orm
        .insert(retroEvidence)
        .values({
          retroId,
          evidenceId: entry.evidenceId,
          repository: entry.repository,
          sourceKind: entry.sourceKind,
          sourceRef: entry.sourceRef,
          occurredAt: entry.occurredAt,
          excerpt: entry.excerpt,
        })
        .onConflictDoNothing()
        .returning({ evidenceId: retroEvidence.evidenceId }),
    );
    if (inserted.length === 1) continue;
    const stored = (yield* listRetroEvidenceSteps(q, retroId)).find(
      (row) => row.evidenceId === entry.evidenceId,
    )!;
    if (
      stored.repository.toLowerCase() !== entry.repository.toLowerCase() ||
      stored.sourceKind !== entry.sourceKind ||
      stored.sourceRef !== entry.sourceRef ||
      stored.occurredAt !== entry.occurredAt ||
      stored.excerpt !== entry.excerpt
    )
      throw new Error(`Retro evidence ${entry.evidenceId} is already stored with other content`);
  }
}

export async function listRetroEvidence(store: Db, retroId: string): Promise<RetroEvidence[]> {
  return store.run((q) => listRetroEvidenceSteps(q, retroId));
}

export function* listRetroEvidenceSteps(q: Q, retroId: string) {
  const { retroEvidence } = q.t;
  return yield* q.all(
    q.orm
      .select({
        evidenceId: retroEvidence.evidenceId,
        repository: retroEvidence.repository,
        sourceKind: retroEvidence.sourceKind,
        sourceRef: retroEvidence.sourceRef,
        occurredAt: retroEvidence.occurredAt,
        excerpt: retroEvidence.excerpt,
      })
      .from(retroEvidence)
      .where(eq(retroEvidence.retroId, retroId))
      .orderBy(retroEvidence.evidenceId),
  );
}

type CoverageGap = {
  retroId: string;
  repository?: string;
  kind: RetroCoverageGapKind;
  detail: string;
  now: number;
};

export async function recordRetroCoverageGap(store: Db, input: CoverageGap): Promise<void> {
  await store.run((q) => recordRetroCoverageGapSteps(q, input));
}

export function* recordRetroCoverageGapSteps(q: Q, input: CoverageGap) {
  yield* q.exec(
    q.orm.insert(q.t.retroCoverageGap).values({
      retroId: input.retroId,
      repository: input.repository ?? null,
      kind: input.kind,
      detail: input.detail,
      recordedAt: input.now,
    }),
  );
}

export async function listRetroCoverageGaps(
  store: Db,
  retroId: string,
): Promise<RetroCoverageGap[]> {
  return store.run((q) => listRetroCoverageGapsSteps(q, retroId));
}

export function* listRetroCoverageGapsSteps(q: Q, retroId: string) {
  const { retroCoverageGap: gap } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        repository: gap.repository,
        kind: gap.kind,
        detail: gap.detail,
        recordedAt: gap.recordedAt,
      })
      .from(gap)
      .where(eq(gap.retroId, retroId))
      .orderBy(gap.id),
  );
  return rows as RetroCoverageGap[];
}

type ArtifactWrite = { retroId: string; kind: RetroArtifactKind; bytes: Uint8Array; now: number };

export function writeRetroArtifact(
  db: Database,
  root: string,
  input: ArtifactWrite,
): RetroArtifactRecord {
  return settled(sqliteDb(db).run((q) => writeRetroArtifactSteps(q, root, input)));
}

export function* writeRetroArtifactSteps(q: Q, root: string, input: ArtifactWrite) {
  const digest = sha256(input.bytes);
  const existing = yield* retroArtifactSteps(q, input.retroId, input.kind);
  if (existing !== null) {
    if (existing.sha256 !== digest)
      throw new Error(`Retro ${input.retroId} already has a different ${input.kind}`);
    return existing;
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const fileName = `${input.retroId}.${input.kind}.${digest}`;
  const target = join(root, fileName);
  if (!existsSync(target)) {
    const partial = join(root, `.${fileName}.part`);
    writeFileSync(partial, input.bytes, { mode: 0o600, flag: "w" });
    chmodSync(partial, 0o600);
    renameSync(partial, target);
  }
  yield* q.exec(
    q.orm.insert(q.t.retroArtifact).values({
      retroId: input.retroId,
      kind: input.kind,
      sha256: digest,
      sizeBytes: input.bytes.byteLength,
      fileName,
      createdAt: input.now,
    }),
  );
  return (yield* retroArtifactSteps(q, input.retroId, input.kind))!;
}

export async function retroArtifact(
  store: Db,
  retroId: string,
  kind: RetroArtifactKind,
): Promise<RetroArtifactRecord | null> {
  return store.run((q) => retroArtifactSteps(q, retroId, kind));
}

export function* retroArtifactSteps(q: Q, retroId: string, kind: RetroArtifactKind) {
  const { retroArtifact: artifact } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        kind: artifact.kind,
        sha256: artifact.sha256,
        sizeBytes: artifact.sizeBytes,
        fileName: artifact.fileName,
        createdAt: artifact.createdAt,
      })
      .from(artifact)
      .where(and(eq(artifact.retroId, retroId), eq(artifact.kind, kind))),
  );
  return row === undefined ? null : (row as RetroArtifactRecord);
}

export function readRetroArtifact(
  db: Database,
  root: string,
  retroId: string,
  kind: RetroArtifactKind,
): RetroArtifactRead {
  return settled(sqliteDb(db).run((q) => readRetroArtifactSteps(q, root, retroId, kind)));
}

export function* readRetroArtifactSteps(
  q: Q,
  root: string,
  retroId: string,
  kind: RetroArtifactKind,
): Steps<RetroArtifactRead> {
  const artifact = yield* retroArtifactSteps(q, retroId, kind);
  if (artifact === null) return { ok: false, reason: "unrecorded" };
  const path = join(root, artifact.fileName);
  if (!existsSync(path)) return { ok: false, reason: "missing_artifact" };
  const bytes = new Uint8Array(readFileSync(path));
  if (bytes.byteLength !== artifact.sizeBytes || sha256(bytes) !== artifact.sha256)
    return { ok: false, reason: "hash_mismatch" };
  return { ok: true, bytes, artifact };
}

type Freeze = { retroId: string; endCursors: Record<string, number>; now: number };

export function freezeRetroInput(db: Database, input: Freeze): Retro {
  return settled(sqliteDb(db).transaction((q) => freezeRetroInputSteps(q, input)));
}

export function* freezeRetroInputSteps(q: Q, input: Freeze) {
  const { retro: retroTable, retroRepository } = q.t;
  const retro = yield* getRetroSteps(q, input.retroId);
  if (retro === null || retro.state !== "collecting")
    throw new Error(`Retro ${input.retroId} is not collecting evidence`);
  const digest = yield* retroArtifactSteps(q, retro.id, "digest");
  const manifest = yield* retroArtifactSteps(q, retro.id, "manifest");
  if (digest === null || manifest === null)
    throw new Error(`Retro ${retro.id} needs its digest and manifest before it is frozen`);
  const cursors = yield* retroRepositoriesSteps(q, retro.id);
  if (cursors.length !== retro.repositories.length)
    throw new Error(`Retro ${retro.id} has not started collection for every repository`);
  for (const cursor of cursors) {
    const end = Object.entries(input.endCursors).find(
      ([repository]) => repository.toLowerCase() === cursor.repository.toLowerCase(),
    )?.[1];
    if (end === undefined || end < cursor.startCursor)
      throw new Error(`Retro ${retro.id} needs an end cursor for ${cursor.repository}`);
    yield* q.exec(
      q.orm
        .update(retroRepository)
        .set({ endCursor: end })
        .where(
          and(
            eq(retroRepository.retroId, retro.id),
            eq(retroRepository.repository, cursor.repository),
          ),
        ),
    );
  }
  yield* q.exec(
    q.orm
      .update(retroTable)
      .set({
        state: "queued",
        digestSha256: digest.sha256,
        manifestSha256: manifest.sha256,
        updatedAt: input.now,
      })
      .where(and(eq(retroTable.id, retro.id), eq(retroTable.state, "collecting"))),
  );
  return (yield* getRetroSteps(q, retro.id))!;
}

type AttemptStart = {
  retroId: string;
  owner: string;
  now: number;
  leaseMs: number;
  maxAttempts?: number;
};

export function startRetroAttempt(db: Database, input: AttemptStart): { attempt: number } | null {
  return settled(sqliteDb(db).transaction((q) => startRetroAttemptSteps(q, input)));
}

export function* startRetroAttemptSteps(
  q: Q,
  input: AttemptStart,
): Steps<{ attempt: number } | null> {
  const { retro: retroTable, retroAttempt } = q.t;
  const retro = yield* getRetroSteps(q, input.retroId);
  if (retro === null) return null;
  const expired = retro.state === "generating" && (retro.ownerExpiresAt ?? 0) <= input.now;
  if (retro.state !== "queued" && retro.state !== "failed" && !expired) return null;
  if (input.maxAttempts !== undefined && retro.attempt >= input.maxAttempts) return null;
  if (expired)
    yield* q.exec(
      q.orm
        .update(retroAttempt)
        .set({ outcome: "expired", finishedAt: input.now })
        .where(
          and(
            eq(retroAttempt.retroId, retro.id),
            eq(retroAttempt.attempt, retro.attempt),
            eq(retroAttempt.outcome, "running"),
          ),
        ),
    );
  const attempt = retro.attempt + 1;
  yield* q.exec(
    q.orm
      .update(retroTable)
      .set({
        state: "generating",
        attempt,
        owner: input.owner,
        ownerExpiresAt: input.now + input.leaseMs,
        error: null,
        updatedAt: input.now,
      })
      .where(and(eq(retroTable.id, retro.id), eq(retroTable.attempt, retro.attempt))),
  );
  yield* q.exec(
    q.orm.insert(retroAttempt).values({
      retroId: retro.id,
      attempt,
      owner: input.owner,
      startedAt: input.now,
      leaseExpiresAt: input.now + input.leaseMs,
      outcome: "running",
    }),
  );
  return { attempt };
}

function* ownsAttemptSteps(q: Q, retroId: string, attempt: number, owner: string) {
  const { retro } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: retro.id })
      .from(retro)
      .where(
        and(
          eq(retro.id, retroId),
          eq(retro.state, "generating"),
          eq(retro.attempt, attempt),
          eq(retro.owner, owner),
        ),
      ),
  );
  return row !== undefined;
}

type AttemptFailure = {
  retroId: string;
  attempt: number;
  owner: string;
  error: string;
  now: number;
};

export async function failRetroAttempt(store: Db, input: AttemptFailure): Promise<boolean> {
  return store.transaction((q) => failRetroAttemptSteps(q, input));
}

export function* failRetroAttemptSteps(q: Q, input: AttemptFailure) {
  const { retro, retroAttempt } = q.t;
  if (!(yield* ownsAttemptSteps(q, input.retroId, input.attempt, input.owner))) return false;
  yield* q.exec(
    q.orm
      .update(retro)
      .set({
        state: "failed",
        owner: null,
        ownerExpiresAt: null,
        error: input.error,
        updatedAt: input.now,
      })
      .where(eq(retro.id, input.retroId)),
  );
  yield* q.exec(
    q.orm
      .update(retroAttempt)
      .set({ outcome: "failed", error: input.error, finishedAt: input.now })
      .where(and(eq(retroAttempt.retroId, input.retroId), eq(retroAttempt.attempt, input.attempt))),
  );
  return true;
}

export async function listRetroAttempts(store: Db, retroId: string): Promise<RetroAttempt[]> {
  return store.run((q) => listRetroAttemptsSteps(q, retroId));
}

export function* listRetroAttemptsSteps(q: Q, retroId: string) {
  const { retroAttempt } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        attempt: retroAttempt.attempt,
        owner: retroAttempt.owner,
        startedAt: retroAttempt.startedAt,
        leaseExpiresAt: retroAttempt.leaseExpiresAt,
        finishedAt: retroAttempt.finishedAt,
        outcome: retroAttempt.outcome,
        error: retroAttempt.error,
      })
      .from(retroAttempt)
      .where(eq(retroAttempt.retroId, retroId))
      .orderBy(retroAttempt.attempt),
  );
  return rows as RetroAttempt[];
}

export type RetroPublication =
  | { ok: true; retro: Retro; items: RetroItem[] }
  | {
      ok: false;
      reason:
        | "not_owner"
        | "coverage_gap"
        | "watermark_moved"
        | "unknown_evidence"
        | "duplicate_item";
    };

type Publication = {
  retroId: string;
  attempt: number;
  owner: string;
  result: unknown;
  items: RetroItemInput[];
  now: number;
};

export function publishRetro(db: Database, input: Publication): RetroPublication {
  return settled(sqliteDb(db).transaction((q) => publishRetroSteps(q, input)));
}

export function* publishRetroSteps(q: Q, input: Publication): Steps<RetroPublication> {
  const { retro: retroTable, retroAttempt, retroItem, retroCollectionLock } = q.t;
  if (!(yield* ownsAttemptSteps(q, input.retroId, input.attempt, input.owner)))
    return { ok: false, reason: "not_owner" };
  const retro = (yield* getRetroSteps(q, input.retroId))!;
  if ((yield* listRetroCoverageGapsSteps(q, retro.id)).length > 0)
    return { ok: false, reason: "coverage_gap" };
  const evidence = new Set(
    (yield* listRetroEvidenceSteps(q, retro.id)).map((entry) => entry.evidenceId),
  );
  if (input.items.some((item) => item.evidenceIds.some((id) => !evidence.has(id))))
    return { ok: false, reason: "unknown_evidence" };
  if (new Set(input.items.map((item) => item.itemId)).size !== input.items.length)
    return { ok: false, reason: "duplicate_item" };
  try {
    yield* q.transaction((tx) => advanceWatermarksSteps(tx, retro, input.now));
  } catch (error) {
    if (error instanceof WatermarkMoved) return { ok: false, reason: "watermark_moved" };
    throw error;
  }
  const text = JSON.stringify(input.result);
  for (const [position, item] of input.items.entries()) {
    const { improvementId } = yield* recordImprovementProposalSteps(q, {
      workspaceId: retro.workspaceId,
      repository: item.repository,
      source: { kind: "retro_item", key: `${retro.id}/${item.itemId}` },
      proposal: {
        title: item.title,
        problem: item.problem,
        proposedChange: item.proposedChange,
        actionStep: item.actionStep,
        verificationCriterion: item.verificationCriterion,
        evidence: item.evidenceIds.map((id) => `retro:${retro.id}:${id}`),
      },
      now: input.now,
    });
    yield* q.exec(
      q.orm.insert(retroItem).values({
        retroId: retro.id,
        itemId: item.itemId,
        position,
        repository: item.repository,
        area: item.area,
        actionStep: item.actionStep,
        title: item.title,
        problem: item.problem,
        proposedChange: item.proposedChange,
        verificationCriterion: item.verificationCriterion,
        evidenceIds: jsonValue(q, item.evidenceIds),
        improvementId,
      }),
    );
  }
  yield* q.exec(
    q.orm
      .update(retroTable)
      .set({
        state: "published",
        result: jsonValue(q, input.result),
        resultSha256: sha256(text),
        owner: null,
        ownerExpiresAt: null,
        error: null,
        publishedAt: input.now,
        updatedAt: input.now,
      })
      .where(eq(retroTable.id, retro.id)),
  );
  yield* q.exec(
    q.orm
      .update(retroAttempt)
      .set({ outcome: "succeeded", finishedAt: input.now })
      .where(and(eq(retroAttempt.retroId, retro.id), eq(retroAttempt.attempt, input.attempt))),
  );
  yield* q.exec(q.orm.delete(retroCollectionLock).where(eq(retroCollectionLock.retroId, retro.id)));
  return {
    ok: true,
    retro: (yield* getRetroSteps(q, retro.id))!,
    items: yield* listRetroItemsSteps(q, retro.id),
  };
}

function* advanceWatermarksSteps(q: Q, retro: Retro, now: number) {
  const { retroWatermark: watermark } = q.t;
  for (const cursor of yield* retroRepositoriesSteps(q, retro.id)) {
    const advanced = yield* q.all(
      q.orm
        .insert(watermark)
        .values({
          workspaceId: retro.workspaceId,
          repository: cursor.repository,
          cursor: cursor.endCursor as number,
          retroId: retro.id,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ repository: watermark.repository }),
    );
    if (advanced.length === 1) continue;
    const moved = yield* q.all(
      q.orm
        .update(watermark)
        .set({ cursor: cursor.endCursor as number, retroId: retro.id, updatedAt: now })
        .where(
          and(
            eq(watermark.workspaceId, retro.workspaceId),
            eq(watermark.repository, cursor.repository),
            eq(watermark.cursor, cursor.startCursor),
          ),
        )
        .returning({ repository: watermark.repository }),
    );
    if (moved.length !== 1) throw new WatermarkMoved();
  }
}

class WatermarkMoved extends Error {}

type Close = {
  retroId: string;
  state: "abandoned" | "coverage_failed";
  error: string;
  now: number;
};

export async function closeRetro(store: Db, input: Close): Promise<boolean> {
  return store.transaction((q) => closeRetroSteps(q, input));
}

export function* closeRetroSteps(q: Q, input: Close) {
  const { retro, retroAttempt, retroCollectionLock } = q.t;
  const changed = yield* q.all(
    q.orm
      .update(retro)
      .set({
        state: input.state,
        error: input.error,
        owner: null,
        ownerExpiresAt: null,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(retro.id, input.retroId),
          notInArray(retro.state, ["published", "abandoned", "coverage_failed"]),
        ),
      )
      .returning({ id: retro.id }),
  );
  if (changed.length === 1) {
    yield* q.exec(
      q.orm
        .update(retroAttempt)
        .set({ outcome: "failed", error: input.error, finishedAt: input.now })
        .where(and(eq(retroAttempt.retroId, input.retroId), eq(retroAttempt.outcome, "running"))),
    );
    yield* q.exec(
      q.orm.delete(retroCollectionLock).where(eq(retroCollectionLock.retroId, input.retroId)),
    );
  }
  return changed.length === 1;
}

export async function listRetroItems(store: Db, retroId: string): Promise<RetroItem[]> {
  return store.run((q) => listRetroItemsSteps(q, retroId));
}

export function* listRetroItemsSteps(q: Q, retroId: string) {
  const { retroItem } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(retroItem)
      .where(eq(retroItem.retroId, retroId))
      .orderBy(retroItem.position),
  );
  return rows.map((row): RetroItem => ({
    ...row,
    actionStep: row.actionStep as ImprovementActionStep,
    evidenceIds: jsonOut<string[]>(q, row.evidenceIds),
  }));
}

type ScheduleRun = {
  workspaceId: string;
  occurrenceAt: number;
  retroId: string;
  nextDueAt: number | null;
  now: number;
};

export async function recordRetroScheduleRun(store: Db, input: ScheduleRun): Promise<void> {
  await store.run((q) => recordRetroScheduleRunSteps(q, input));
}

export function* recordRetroScheduleRunSteps(q: Q, input: ScheduleRun) {
  const { retroScheduleRuntime: runtime } = q.t;
  yield* q.exec(
    q.orm
      .insert(runtime)
      .values({
        workspaceId: input.workspaceId,
        lastOccurrenceAt: input.occurrenceAt,
        lastRetroId: input.retroId,
        nextDueAt: input.nextDueAt,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: runtime.workspaceId,
        set: {
          lastOccurrenceAt: sql`excluded.last_occurrence_at`,
          lastRetroId: sql`excluded.last_retro_id`,
          nextDueAt: sql`excluded.next_due_at`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: sql`coalesce(${runtime.lastOccurrenceAt}, -1) <= excluded.last_occurrence_at`,
      }),
  );
}

export async function retroScheduleRuntime(
  store: Db,
  workspaceId: string,
): Promise<RetroScheduleRuntime | null> {
  return store.run((q) => retroScheduleRuntimeSteps(q, workspaceId));
}

export function* retroScheduleRuntimeSteps(q: Q, workspaceId: string) {
  const { retroScheduleRuntime: runtime } = q.t;
  const row = yield* q.one(
    q.orm.select().from(runtime).where(eq(runtime.workspaceId, workspaceId)),
  );
  return row ?? null;
}

type ScheduleState = {
  workspaceId: string;
  nextDueAt: number | null;
  blockedReason: string | null;
  now: number;
};

export async function recordRetroScheduleState(store: Db, input: ScheduleState): Promise<void> {
  await store.run((q) => recordRetroScheduleStateSteps(q, input));
}

export function* recordRetroScheduleStateSteps(q: Q, input: ScheduleState) {
  const { retroScheduleRuntime: runtime } = q.t;
  yield* q.exec(
    q.orm
      .insert(runtime)
      .values({
        workspaceId: input.workspaceId,
        nextDueAt: input.nextDueAt,
        blockedReason: input.blockedReason,
        blockedSince: input.blockedReason === null ? null : input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: runtime.workspaceId,
        set: {
          nextDueAt: sql`excluded.next_due_at`,
          blockedReason: sql`excluded.blocked_reason`,
          blockedSince: sql`CASE WHEN excluded.blocked_reason IS NULL THEN NULL
            WHEN ${runtime.blockedReason} IS NOT DISTINCT FROM excluded.blocked_reason
              THEN ${runtime.blockedSince}
            ELSE excluded.blocked_since END`,
          updatedAt: sql`excluded.updated_at`,
        },
        setWhere: sql`${runtime.nextDueAt} IS DISTINCT FROM excluded.next_due_at
          OR ${runtime.blockedReason} IS DISTINCT FROM excluded.blocked_reason`,
      }),
  );
}

/** Every settings revision of a workspace, newest first. */
export async function listRetroSettingsRevisions(
  store: Db,
  workspaceId: string,
): Promise<RetroSettingsRevision[]> {
  return store.run((q) => listRetroSettingsRevisionsSteps(q, workspaceId));
}

export function* listRetroSettingsRevisionsSteps(q: Q, workspaceId: string) {
  const { retroSettingsRevision: settings } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(settings)
      .where(eq(settings.workspaceId, workspaceId))
      .orderBy(desc(settings.revision)),
  );
  return rows.map((row) => settingsFromRow(q, row));
}

/** Workspaces that saved retro settings, in id order. */
export async function retroSettingsWorkspaces(store: Db): Promise<string[]> {
  return store.run((q) => retroSettingsWorkspacesSteps(q));
}

export function* retroSettingsWorkspacesSteps(q: Q) {
  const { retroSettingsRevision: settings } = q.t;
  const rows = yield* q.all(
    q.orm
      .selectDistinct({ workspaceId: settings.workspaceId })
      .from(settings)
      .orderBy(settings.workspaceId),
  );
  return rows.map((row) => row.workspaceId);
}

/** The id of the workspace's retro over exactly this window. */
export async function retroIdForWindow(
  store: Db,
  workspaceId: string,
  windowStart: number,
  windowEnd: number,
): Promise<string | null> {
  return store.run((q) => retroIdForWindowSteps(q, workspaceId, windowStart, windowEnd));
}

export function* retroIdForWindowSteps(
  q: Q,
  workspaceId: string,
  windowStart: number,
  windowEnd: number,
) {
  const { retro } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: retro.id })
      .from(retro)
      .where(
        and(
          eq(retro.workspaceId, workspaceId),
          eq(retro.windowStart, windowStart),
          eq(retro.windowEnd, windowEnd),
        ),
      ),
  );
  return row?.id ?? null;
}

/** The workspace's most recently created retro, limited to `states` when given. */
export async function latestRetro(
  store: Db,
  workspaceId: string,
  states?: readonly RetroState[],
): Promise<Retro | null> {
  return store.run((q) => latestRetroSteps(q, workspaceId, states));
}

export function* latestRetroSteps(q: Q, workspaceId: string, states?: readonly RetroState[]) {
  const { retro } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(retro)
      .where(
        and(
          eq(retro.workspaceId, workspaceId),
          states === undefined ? undefined : inArray(retro.state, [...states]),
        ),
      )
      .orderBy(desc(retro.createdAt), desc(retro.id))
      .limit(1),
  );
  return row === undefined ? null : retroFromRow(q, row);
}

/** The published retro with the latest window end. */
export async function latestPublishedRetro(store: Db, workspaceId: string): Promise<Retro | null> {
  return store.run((q) => latestPublishedRetroSteps(q, workspaceId));
}

export function* latestPublishedRetroSteps(q: Q, workspaceId: string) {
  const { retro } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(retro)
      .where(and(eq(retro.workspaceId, workspaceId), eq(retro.state, "published")))
      .orderBy(desc(retro.windowEnd), desc(retro.id))
      .limit(1),
  );
  return row === undefined ? null : retroFromRow(q, row);
}

/** Ids of the workspace's retros still collecting evidence, oldest first. */
export async function collectingRetroIds(store: Db, workspaceId: string): Promise<string[]> {
  return store.run((q) => collectingRetroIdsSteps(q, workspaceId));
}

export function* collectingRetroIdsSteps(q: Q, workspaceId: string) {
  const { retro } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ id: retro.id })
      .from(retro)
      .where(and(eq(retro.workspaceId, workspaceId), eq(retro.state, "collecting")))
      .orderBy(retro.createdAt),
  );
  return rows.map((row) => row.id);
}

type OccurrenceRow = typeof pgSchema.retroOccurrence.$inferSelect;

/** Record the occurrence a new retro covers; an occurrence already recorded stays. */
export async function recordRetroOccurrence(store: Db, occurrence: OccurrenceRow): Promise<void> {
  await store.run((q) => recordRetroOccurrenceSteps(q, occurrence));
}

export function* recordRetroOccurrenceSteps(q: Q, occurrence: OccurrenceRow) {
  yield* q.exec(q.orm.insert(q.t.retroOccurrence).values(occurrence).onConflictDoNothing());
}

/** The schedule occurrence a retro was claimed for. */
export type RetroOccurrenceRecord = {
  origin: string;
  occurrenceAt: number;
  timeZone: string;
  localDate: string;
  localTime: string;
  utcOffsetMinutes: number;
  adjustment: string;
  requestedBy: string | null;
};

export async function retroOccurrence(
  store: Db,
  retroId: string,
): Promise<RetroOccurrenceRecord | null> {
  return store.run((q) => retroOccurrenceSteps(q, retroId));
}

export function* retroOccurrenceSteps(q: Q, retroId: string) {
  const { retroOccurrence: occurrence } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        origin: occurrence.origin,
        occurrenceAt: occurrence.occurrenceAt,
        timeZone: occurrence.timeZone,
        localDate: occurrence.localDate,
        localTime: occurrence.localTime,
        utcOffsetMinutes: occurrence.utcOffsetMinutes,
        adjustment: occurrence.localAdjustment,
        requestedBy: occurrence.requestedBy,
      })
      .from(occurrence)
      .where(eq(occurrence.retroId, retroId)),
  );
  return row ?? null;
}
