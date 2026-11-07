import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { and, desc, eq, max } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { recordImprovementProposal, type ImprovementActionStep } from "./improvements";
import { jsonValue } from "./json-text";
import type * as pgSchema from "./schema-pg";
import { immediate } from "./tx";
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

export type RetroScheduleRuntime = {
  workspaceId: string;
  lastOccurrenceAt: number | null;
  lastRetroId: string | null;
  nextDueAt: number | null;
  blockedReason: string | null;
  blockedSince: number | null;
  updatedAt: number;
};

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

export function getRetroSettingsRevision(
  db: Database,
  workspaceId: string,
  revision: number,
): RetroSettingsRevision | null {
  return settled(sqliteDb(db).run((q) => getRetroSettingsRevisionSteps(q, workspaceId, revision)));
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

export function latestRetroSettingsRevision(
  db: Database,
  workspaceId: string,
): RetroSettingsRevision | null {
  return settled(sqliteDb(db).run((q) => latestRetroSettingsRevisionSteps(q, workspaceId)));
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

export function getRetro(db: Database, id: string): Retro | null {
  return settled(sqliteDb(db).run((q) => getRetroSteps(q, id)));
}

export function* getRetroSteps(q: Q, id: string) {
  const row = yield* q.one(q.orm.select().from(q.t.retro).where(eq(q.t.retro.id, id)));
  return row === undefined ? null : retroFromRow(q, row);
}

export function listRetros(db: Database, workspaceId: string): Retro[] {
  return settled(sqliteDb(db).run((q) => listRetrosSteps(q, workspaceId)));
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

export function retroRepositories(db: Database, retroId: string): RetroRepositoryCursor[] {
  return settled(sqliteDb(db).run((q) => retroRepositoriesSteps(q, retroId)));
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

export function retroWatermarks(
  db: Database,
  workspaceId: string,
): { repository: string; cursor: number; retroId: string; updatedAt: number }[] {
  return settled(sqliteDb(db).run((q) => retroWatermarksSteps(q, workspaceId)));
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

export function listRetroEvidence(db: Database, retroId: string): RetroEvidence[] {
  return settled(sqliteDb(db).run((q) => listRetroEvidenceSteps(q, retroId)));
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

export function recordRetroCoverageGap(db: Database, input: CoverageGap): void {
  settled(sqliteDb(db).run((q) => recordRetroCoverageGapSteps(q, input)));
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

export function listRetroCoverageGaps(db: Database, retroId: string): RetroCoverageGap[] {
  return settled(sqliteDb(db).run((q) => listRetroCoverageGapsSteps(q, retroId)));
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

export function retroArtifact(
  db: Database,
  retroId: string,
  kind: RetroArtifactKind,
): RetroArtifactRecord | null {
  return settled(sqliteDb(db).run((q) => retroArtifactSteps(q, retroId, kind)));
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

export function freezeRetroInput(
  db: Database,
  input: { retroId: string; endCursors: Record<string, number>; now: number },
): Retro {
  return immediate(db, () => {
    const retro = getRetro(db, input.retroId);
    if (retro === null || retro.state !== "collecting")
      throw new Error(`Retro ${input.retroId} is not collecting evidence`);
    const digest = retroArtifact(db, retro.id, "digest");
    const manifest = retroArtifact(db, retro.id, "manifest");
    if (digest === null || manifest === null)
      throw new Error(`Retro ${retro.id} needs its digest and manifest before it is frozen`);
    const cursors = retroRepositories(db, retro.id);
    if (cursors.length !== retro.repositories.length)
      throw new Error(`Retro ${retro.id} has not started collection for every repository`);
    for (const cursor of cursors) {
      const end = Object.entries(input.endCursors).find(
        ([repository]) => repository.toLowerCase() === cursor.repository.toLowerCase(),
      )?.[1];
      if (end === undefined || end < cursor.startCursor)
        throw new Error(`Retro ${retro.id} needs an end cursor for ${cursor.repository}`);
      db.run("UPDATE retro_repository SET end_cursor = ? WHERE retro_id = ? AND repository = ?", [
        end,
        retro.id,
        cursor.repository,
      ]);
    }
    db.run(
      `UPDATE retro SET state = 'queued', digest_sha256 = ?, manifest_sha256 = ?, updated_at = ?
       WHERE id = ? AND state = 'collecting'`,
      [digest.sha256, manifest.sha256, input.now, retro.id],
    );
    return getRetro(db, retro.id)!;
  });
}

export function startRetroAttempt(
  db: Database,
  input: { retroId: string; owner: string; now: number; leaseMs: number; maxAttempts?: number },
): { attempt: number } | null {
  return immediate(db, () => {
    const retro = getRetro(db, input.retroId);
    if (retro === null) return null;
    const expired = retro.state === "generating" && (retro.ownerExpiresAt ?? 0) <= input.now;
    if (retro.state !== "queued" && retro.state !== "failed" && !expired) return null;
    if (input.maxAttempts !== undefined && retro.attempt >= input.maxAttempts) return null;
    if (expired)
      db.run(
        `UPDATE retro_attempt SET outcome = 'expired', finished_at = ?
         WHERE retro_id = ? AND attempt = ? AND outcome = 'running'`,
        [input.now, retro.id, retro.attempt],
      );
    const attempt = retro.attempt + 1;
    db.run(
      `UPDATE retro SET state = 'generating', attempt = ?, owner = ?, owner_expires_at = ?,
         error = NULL, updated_at = ? WHERE id = ? AND attempt = ?`,
      [attempt, input.owner, input.now + input.leaseMs, input.now, retro.id, retro.attempt],
    );
    db.run(
      `INSERT INTO retro_attempt (retro_id, attempt, owner, started_at, lease_expires_at, outcome)
       VALUES (?, ?, ?, ?, ?, 'running')`,
      [retro.id, attempt, input.owner, input.now, input.now + input.leaseMs],
    );
    return { attempt };
  });
}

function ownsAttempt(db: Database, retroId: string, attempt: number, owner: string): boolean {
  return (
    db
      .query(
        "SELECT 1 FROM retro WHERE id = ? AND state = 'generating' AND attempt = ? AND owner = ?",
      )
      .get(retroId, attempt, owner) !== null
  );
}

export function failRetroAttempt(
  db: Database,
  input: { retroId: string; attempt: number; owner: string; error: string; now: number },
): boolean {
  return immediate(db, () => {
    if (!ownsAttempt(db, input.retroId, input.attempt, input.owner)) return false;
    db.run(
      `UPDATE retro SET state = 'failed', owner = NULL, owner_expires_at = NULL, error = ?,
         updated_at = ? WHERE id = ?`,
      [input.error, input.now, input.retroId],
    );
    db.run(
      `UPDATE retro_attempt SET outcome = 'failed', error = ?, finished_at = ?
       WHERE retro_id = ? AND attempt = ?`,
      [input.error, input.now, input.retroId, input.attempt],
    );
    return true;
  });
}

export function listRetroAttempts(db: Database, retroId: string): RetroAttempt[] {
  return db
    .query<RetroAttempt, [string]>(
      `SELECT attempt, owner, started_at AS startedAt, lease_expires_at AS leaseExpiresAt,
         finished_at AS finishedAt, outcome, error FROM retro_attempt WHERE retro_id = ? ORDER BY attempt`,
    )
    .all(retroId);
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

export function publishRetro(
  db: Database,
  input: {
    retroId: string;
    attempt: number;
    owner: string;
    result: unknown;
    items: RetroItemInput[];
    now: number;
  },
): RetroPublication {
  try {
    return immediate(db, () => {
      if (!ownsAttempt(db, input.retroId, input.attempt, input.owner))
        return { ok: false, reason: "not_owner" } as const;
      const retro = getRetro(db, input.retroId)!;
      if (listRetroCoverageGaps(db, retro.id).length > 0)
        return { ok: false, reason: "coverage_gap" } as const;
      const evidence = new Set(listRetroEvidence(db, retro.id).map((entry) => entry.evidenceId));
      if (input.items.some((item) => item.evidenceIds.some((id) => !evidence.has(id))))
        return { ok: false, reason: "unknown_evidence" } as const;
      if (new Set(input.items.map((item) => item.itemId)).size !== input.items.length)
        return { ok: false, reason: "duplicate_item" } as const;
      for (const cursor of retroRepositories(db, retro.id)) {
        const advanced = db.run(
          `INSERT INTO retro_watermark (workspace_id, repository, cursor, retro_id, updated_at)
           SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
             SELECT 1 FROM retro_watermark WHERE workspace_id = ? AND repository = ?)
           ON CONFLICT DO NOTHING`,
          [
            retro.workspaceId,
            cursor.repository,
            cursor.endCursor,
            retro.id,
            input.now,
            retro.workspaceId,
            cursor.repository,
          ],
        ).changes;
        if (advanced === 1) continue;
        const moved = db.run(
          `UPDATE retro_watermark SET cursor = ?, retro_id = ?, updated_at = ?
           WHERE workspace_id = ? AND repository = ? AND cursor = ?`,
          [
            cursor.endCursor,
            retro.id,
            input.now,
            retro.workspaceId,
            cursor.repository,
            cursor.startCursor,
          ],
        ).changes;
        if (moved !== 1) throw new WatermarkMoved();
      }
      const text = JSON.stringify(input.result);
      input.items.forEach((item, position) => {
        const { improvementId } = recordImprovementProposal(db, {
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
        db.run(
          `INSERT INTO retro_item (retro_id, item_id, position, repository, area, action_step, title,
             problem, proposed_change, verification_criterion, evidence_ids, improvement_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            retro.id,
            item.itemId,
            position,
            item.repository,
            item.area,
            item.actionStep,
            item.title,
            item.problem,
            item.proposedChange,
            item.verificationCriterion,
            JSON.stringify(item.evidenceIds),
            improvementId,
          ],
        );
      });
      db.run(
        `UPDATE retro SET state = 'published', result = ?, result_sha256 = ?, owner = NULL,
           owner_expires_at = NULL, error = NULL, published_at = ?, updated_at = ? WHERE id = ?`,
        [text, sha256(text), input.now, input.now, retro.id],
      );
      db.run(
        `UPDATE retro_attempt SET outcome = 'succeeded', finished_at = ?
         WHERE retro_id = ? AND attempt = ?`,
        [input.now, retro.id, input.attempt],
      );
      db.run("DELETE FROM retro_collection_lock WHERE retro_id = ?", [retro.id]);
      return { ok: true, retro: getRetro(db, retro.id)!, items: listRetroItems(db, retro.id) };
    });
  } catch (error) {
    if (error instanceof WatermarkMoved) return { ok: false, reason: "watermark_moved" };
    throw error;
  }
}

class WatermarkMoved extends Error {}

export function closeRetro(
  db: Database,
  input: { retroId: string; state: "abandoned" | "coverage_failed"; error: string; now: number },
): boolean {
  return immediate(db, () => {
    const changed = db.run(
      `UPDATE retro SET state = ?, error = ?, owner = NULL, owner_expires_at = NULL, updated_at = ?
       WHERE id = ? AND state NOT IN ('published','abandoned','coverage_failed')`,
      [input.state, input.error, input.now, input.retroId],
    ).changes;
    if (changed === 1) {
      db.run(
        `UPDATE retro_attempt SET outcome = 'failed', error = ?, finished_at = ?
         WHERE retro_id = ? AND outcome = 'running'`,
        [input.error, input.now, input.retroId],
      );
      db.run("DELETE FROM retro_collection_lock WHERE retro_id = ?", [input.retroId]);
    }
    return changed === 1;
  });
}

export function listRetroItems(db: Database, retroId: string): RetroItem[] {
  return db
    .query<Omit<RetroItem, "evidenceIds"> & { evidenceIds: string }, [string]>(
      `SELECT retro_id AS retroId, item_id AS itemId, position, repository, area,
         action_step AS actionStep, title, problem, proposed_change AS proposedChange,
         verification_criterion AS verificationCriterion, evidence_ids AS evidenceIds,
         improvement_id AS improvementId
       FROM retro_item WHERE retro_id = ? ORDER BY position`,
    )
    .all(retroId)
    .map((row) => ({ ...row, evidenceIds: JSON.parse(row.evidenceIds) as string[] }));
}

export function recordRetroScheduleRun(
  db: Database,
  input: {
    workspaceId: string;
    occurrenceAt: number;
    retroId: string;
    nextDueAt: number | null;
    now: number;
  },
): void {
  db.run(
    `INSERT INTO retro_schedule_runtime (workspace_id, last_occurrence_at, last_retro_id,
       next_due_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id) DO UPDATE SET last_occurrence_at = excluded.last_occurrence_at,
       last_retro_id = excluded.last_retro_id, next_due_at = excluded.next_due_at,
       updated_at = excluded.updated_at
     WHERE coalesce(last_occurrence_at, -1) <= excluded.last_occurrence_at`,
    [input.workspaceId, input.occurrenceAt, input.retroId, input.nextDueAt, input.now],
  );
}

export function retroScheduleRuntime(
  db: Database,
  workspaceId: string,
): RetroScheduleRuntime | null {
  return db
    .query<RetroScheduleRuntime, [string]>(
      `SELECT workspace_id AS workspaceId, last_occurrence_at AS lastOccurrenceAt,
         last_retro_id AS lastRetroId, next_due_at AS nextDueAt, blocked_reason AS blockedReason,
         blocked_since AS blockedSince, updated_at AS updatedAt
       FROM retro_schedule_runtime WHERE workspace_id = ?`,
    )
    .get(workspaceId);
}

export function recordRetroScheduleState(
  db: Database,
  input: {
    workspaceId: string;
    nextDueAt: number | null;
    blockedReason: string | null;
    now: number;
  },
): void {
  db.run(
    `INSERT INTO retro_schedule_runtime (workspace_id, next_due_at, blocked_reason, blocked_since,
       updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id) DO UPDATE SET next_due_at = excluded.next_due_at,
       blocked_reason = excluded.blocked_reason,
       blocked_since = CASE WHEN excluded.blocked_reason IS NULL THEN NULL
         WHEN retro_schedule_runtime.blocked_reason IS excluded.blocked_reason
           THEN retro_schedule_runtime.blocked_since
         ELSE excluded.blocked_since END,
       updated_at = excluded.updated_at
     WHERE retro_schedule_runtime.next_due_at IS NOT excluded.next_due_at
       OR retro_schedule_runtime.blocked_reason IS NOT excluded.blocked_reason`,
    [
      input.workspaceId,
      input.nextDueAt,
      input.blockedReason,
      input.blockedReason === null ? null : input.now,
      input.now,
    ],
  );
}
