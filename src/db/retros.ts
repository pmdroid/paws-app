import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { recordImprovementProposal, type ImprovementActionStep } from "./improvements";
import { immediate } from "./tx";

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
  updatedAt: number;
};

const parse = (text: string) => JSON.parse(text) as Record<string, unknown>;
const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

export function saveRetroSettingsRevision(
  db: Database,
  input: RetroSettings & { workspaceId: string; createdBy: string; now: number },
): RetroSettingsRevision {
  return immediate(db, () => {
    const revision =
      (db
        .query<{ revision: number | null }, [string]>(
          "SELECT max(revision) AS revision FROM retro_settings_revision WHERE workspace_id = ?",
        )
        .get(input.workspaceId)?.revision ?? 0) + 1;
    db.run(
      `INSERT INTO retro_settings_revision (workspace_id, revision, prompt, agent_profile,
         repositories, output_limits, execution_limits, schedule, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.workspaceId,
        revision,
        input.prompt,
        JSON.stringify(input.agentProfile),
        JSON.stringify(input.repositories),
        JSON.stringify(input.outputLimits),
        JSON.stringify(input.executionLimits),
        JSON.stringify(input.schedule),
        input.createdBy,
        input.now,
      ],
    );
    return getRetroSettingsRevision(db, input.workspaceId, revision)!;
  });
}

type SettingsRow = {
  workspace_id: string;
  revision: number;
  prompt: string;
  agent_profile: string;
  repositories: string;
  output_limits: string;
  execution_limits: string;
  schedule: string;
  created_by: string;
  created_at: number;
};

function settingsFromRow(row: SettingsRow): RetroSettingsRevision {
  return {
    workspaceId: row.workspace_id,
    revision: row.revision,
    prompt: row.prompt,
    agentProfile: parse(row.agent_profile),
    repositories: JSON.parse(row.repositories) as string[],
    outputLimits: parse(row.output_limits),
    executionLimits: parse(row.execution_limits),
    schedule: parse(row.schedule),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export function getRetroSettingsRevision(
  db: Database,
  workspaceId: string,
  revision: number,
): RetroSettingsRevision | null {
  const row = db
    .query<SettingsRow, [string, number]>(
      "SELECT * FROM retro_settings_revision WHERE workspace_id = ? AND revision = ?",
    )
    .get(workspaceId, revision);
  return row === null ? null : settingsFromRow(row);
}

export function latestRetroSettingsRevision(
  db: Database,
  workspaceId: string,
): RetroSettingsRevision | null {
  const row = db
    .query<SettingsRow, [string]>(
      "SELECT * FROM retro_settings_revision WHERE workspace_id = ? ORDER BY revision DESC LIMIT 1",
    )
    .get(workspaceId);
  return row === null ? null : settingsFromRow(row);
}

type RetroRow = {
  id: string;
  workspace_id: string;
  window_start: number;
  window_end: number;
  origin: RetroOrigin;
  scheduled_for: number | null;
  settings_revision: number;
  prompt: string;
  agent_profile: string;
  repositories: string;
  output_limits: string;
  execution_limits: string;
  state: RetroState;
  digest_sha256: string | null;
  manifest_sha256: string | null;
  attempt: number;
  owner: string | null;
  owner_expires_at: number | null;
  result: string | null;
  result_sha256: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
};

function retroFromRow(row: RetroRow): Retro {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    origin: row.origin,
    scheduledFor: row.scheduled_for,
    settingsRevision: row.settings_revision,
    prompt: row.prompt,
    agentProfile: parse(row.agent_profile),
    repositories: JSON.parse(row.repositories) as string[],
    outputLimits: parse(row.output_limits),
    executionLimits: parse(row.execution_limits),
    state: row.state,
    digestSha256: row.digest_sha256,
    manifestSha256: row.manifest_sha256,
    attempt: row.attempt,
    owner: row.owner,
    ownerExpiresAt: row.owner_expires_at,
    result: row.result === null ? null : JSON.parse(row.result),
    resultSha256: row.result_sha256,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

export function getRetro(db: Database, id: string): Retro | null {
  const row = db.query<RetroRow, [string]>("SELECT * FROM retro WHERE id = ?").get(id);
  return row === null ? null : retroFromRow(row);
}

export function listRetros(db: Database, workspaceId: string): Retro[] {
  return db
    .query<RetroRow, [string]>(
      "SELECT * FROM retro WHERE workspace_id = ? ORDER BY window_end DESC, id",
    )
    .all(workspaceId)
    .map(retroFromRow);
}

export function createRetro(
  db: Database,
  input: {
    id: string;
    workspaceId: string;
    windowStart: number;
    windowEnd: number;
    origin: RetroOrigin;
    scheduledFor?: number;
    settingsRevision: number;
    now: number;
  },
): { retro: Retro; created: boolean } {
  return immediate(db, () => {
    const existing = db
      .query<RetroRow, [string, number, number]>(
        "SELECT * FROM retro WHERE workspace_id = ? AND window_start = ? AND window_end = ?",
      )
      .get(input.workspaceId, input.windowStart, input.windowEnd);
    if (existing !== null) return { retro: retroFromRow(existing), created: false };
    const settings = getRetroSettingsRevision(db, input.workspaceId, input.settingsRevision);
    if (settings === null)
      throw new Error(`Unknown retro settings revision ${input.settingsRevision}`);
    db.run(
      `INSERT INTO retro (id, workspace_id, window_start, window_end, origin, scheduled_for,
         settings_revision, prompt, agent_profile, repositories, output_limits, execution_limits,
         state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'collecting', ?, ?)`,
      [
        input.id,
        input.workspaceId,
        input.windowStart,
        input.windowEnd,
        input.origin,
        input.scheduledFor ?? null,
        settings.revision,
        settings.prompt,
        JSON.stringify(settings.agentProfile),
        JSON.stringify(settings.repositories),
        JSON.stringify(settings.outputLimits),
        JSON.stringify(settings.executionLimits),
        input.now,
        input.now,
      ],
    );
    return { retro: getRetro(db, input.id)!, created: true };
  });
}

export function retroRepositories(db: Database, retroId: string): RetroRepositoryCursor[] {
  return db
    .query<RetroRepositoryCursor, [string]>(
      `SELECT repository, start_cursor AS startCursor, end_cursor AS endCursor
       FROM retro_repository WHERE retro_id = ? ORDER BY repository`,
    )
    .all(retroId);
}

export function retroWatermarks(
  db: Database,
  workspaceId: string,
): { repository: string; cursor: number; retroId: string; updatedAt: number }[] {
  return db
    .query<{ repository: string; cursor: number; retroId: string; updatedAt: number }, [string]>(
      `SELECT repository, cursor, retro_id AS retroId, updated_at AS updatedAt
       FROM retro_watermark WHERE workspace_id = ? ORDER BY repository`,
    )
    .all(workspaceId);
}

export function beginRetroCollection(
  db: Database,
  input: { retroId: string; initialCursors?: Record<string, number>; now: number },
):
  | { ok: true; repositories: RetroRepositoryCursor[] }
  | { ok: false; reason: "not_collecting" }
  | { ok: false; reason: "busy"; busy: { repository: string; retroId: string }[] } {
  return immediate(db, () => {
    const retro = getRetro(db, input.retroId);
    if (retro === null || retro.state !== "collecting")
      return { ok: false, reason: "not_collecting" };
    const busy = retro.repositories.flatMap((repository) => {
      const holder = db
        .query<{ retroId: string }, [string, string]>(
          "SELECT retro_id AS retroId FROM retro_collection_lock WHERE workspace_id = ? AND repository = ?",
        )
        .get(retro.workspaceId, repository);
      return holder !== null && holder.retroId !== retro.id
        ? [{ repository, retroId: holder.retroId }]
        : [];
    });
    if (busy.length > 0) return { ok: false, reason: "busy", busy };
    for (const repository of retro.repositories) {
      db.run(
        `INSERT INTO retro_collection_lock (workspace_id, repository, retro_id, acquired_at)
         VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [retro.workspaceId, repository, retro.id, input.now],
      );
      const watermark = db
        .query<{ cursor: number }, [string, string]>(
          "SELECT cursor FROM retro_watermark WHERE workspace_id = ? AND repository = ?",
        )
        .get(retro.workspaceId, repository);
      db.run(
        `INSERT INTO retro_repository (retro_id, repository, start_cursor) VALUES (?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [retro.id, repository, watermark?.cursor ?? input.initialCursors?.[repository] ?? 0],
      );
    }
    return { ok: true, repositories: retroRepositories(db, retro.id) };
  });
}

export function recordRetroEvidence(
  db: Database,
  retroId: string,
  evidence: RetroEvidence[],
): void {
  immediate(db, () => {
    if (getRetro(db, retroId)?.state !== "collecting")
      throw new Error(`Retro ${retroId} is not collecting evidence`);
    for (const entry of evidence) {
      const inserted = db.run(
        `INSERT INTO retro_evidence (retro_id, evidence_id, repository, source_kind, source_ref,
           occurred_at, excerpt) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
        [
          retroId,
          entry.evidenceId,
          entry.repository,
          entry.sourceKind,
          entry.sourceRef,
          entry.occurredAt,
          entry.excerpt,
        ],
      ).changes;
      if (inserted === 1) continue;
      const stored = listRetroEvidence(db, retroId).find(
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
  });
}

export function listRetroEvidence(db: Database, retroId: string): RetroEvidence[] {
  return db
    .query<RetroEvidence, [string]>(
      `SELECT evidence_id AS evidenceId, repository, source_kind AS sourceKind,
         source_ref AS sourceRef, occurred_at AS occurredAt, excerpt
       FROM retro_evidence WHERE retro_id = ? ORDER BY evidence_id`,
    )
    .all(retroId);
}

export function recordRetroCoverageGap(
  db: Database,
  input: {
    retroId: string;
    repository?: string;
    kind: RetroCoverageGapKind;
    detail: string;
    now: number;
  },
): void {
  db.run(
    `INSERT INTO retro_coverage_gap (retro_id, repository, kind, detail, recorded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [input.retroId, input.repository ?? null, input.kind, input.detail, input.now],
  );
}

export function listRetroCoverageGaps(db: Database, retroId: string): RetroCoverageGap[] {
  return db
    .query<RetroCoverageGap, [string]>(
      `SELECT repository, kind, detail, recorded_at AS recordedAt
       FROM retro_coverage_gap WHERE retro_id = ? ORDER BY id`,
    )
    .all(retroId);
}

export function writeRetroArtifact(
  db: Database,
  root: string,
  input: { retroId: string; kind: RetroArtifactKind; bytes: Uint8Array; now: number },
): RetroArtifactRecord {
  const digest = sha256(input.bytes);
  const existing = retroArtifact(db, input.retroId, input.kind);
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
  db.run(
    `INSERT INTO retro_artifact (retro_id, kind, sha256, size_bytes, file_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [input.retroId, input.kind, digest, input.bytes.byteLength, fileName, input.now],
  );
  return retroArtifact(db, input.retroId, input.kind)!;
}

export function retroArtifact(
  db: Database,
  retroId: string,
  kind: RetroArtifactKind,
): RetroArtifactRecord | null {
  return db
    .query<RetroArtifactRecord, [string, string]>(
      `SELECT kind, sha256, size_bytes AS sizeBytes, file_name AS fileName, created_at AS createdAt
       FROM retro_artifact WHERE retro_id = ? AND kind = ?`,
    )
    .get(retroId, kind);
}

export function readRetroArtifact(
  db: Database,
  root: string,
  retroId: string,
  kind: RetroArtifactKind,
): RetroArtifactRead {
  const artifact = retroArtifact(db, retroId, kind);
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
  | { ok: false; reason: "not_owner" | "watermark_moved" | "unknown_evidence" | "duplicate_item" };

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
         last_retro_id AS lastRetroId, next_due_at AS nextDueAt, updated_at AS updatedAt
       FROM retro_schedule_runtime WHERE workspace_id = ?`,
    )
    .get(workspaceId);
}
