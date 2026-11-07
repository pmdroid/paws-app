import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { citext } from "./types";
import { workspace } from "./workspace";
import { improvement } from "./improvements";
import { runner } from "./runners";

export const retroSettingsRevision = pgTable(
  "retro_settings_revision",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    revision: bigint({ mode: "number" }).notNull(),
    prompt: text().notNull(),
    agentProfile: jsonb("agent_profile").notNull(),
    repositories: jsonb().notNull(),
    outputLimits: jsonb("output_limits").notNull(),
    executionLimits: jsonb("execution_limits").notNull(),
    schedule: jsonb().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.revision],
      name: "retro_settings_revision_workspace_id_revision_pk",
    }),
    check("retro_settings_revision_check_1", sql`revision >= 1`),
    check("retro_settings_revision_check_2", sql`length(prompt) BETWEEN 1 AND 16000`),
    check("retro_settings_revision_check_4", sql`jsonb_typeof(repositories) = 'array'`),
  ],
);

export const retro = pgTable(
  "retro",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    windowStart: bigint("window_start", { mode: "number" }).notNull(),
    windowEnd: bigint("window_end", { mode: "number" }).notNull(),
    origin: text().notNull(),
    scheduledFor: bigint("scheduled_for", { mode: "number" }),
    settingsRevision: bigint("settings_revision", { mode: "number" }).notNull(),
    prompt: text().notNull(),
    agentProfile: jsonb("agent_profile").notNull(),
    repositories: jsonb().notNull(),
    outputLimits: jsonb("output_limits").notNull(),
    executionLimits: jsonb("execution_limits").notNull(),
    state: text().notNull(),
    digestSha256: text("digest_sha256"),
    manifestSha256: text("manifest_sha256"),
    attempt: bigint({ mode: "number" }).default(0).notNull(),
    owner: text(),
    ownerExpiresAt: bigint("owner_expires_at", { mode: "number" }),
    result: jsonb(),
    resultSha256: text("result_sha256"),
    error: text(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    publishedAt: bigint("published_at", { mode: "number" }),
  },
  (table) => [
    unique().on(table.workspaceId, table.windowStart, table.windowEnd),
    index("retro_workspace").on(table.workspaceId, table.windowEnd),
    foreignKey({
      columns: [table.workspaceId, table.settingsRevision],
      foreignColumns: [retroSettingsRevision.workspaceId, retroSettingsRevision.revision],
      name: "retro_workspace_id_settings_revision_retro_settings_revision_workspace_id_revision_fk",
    }),
    check("retro_check_1", sql`window_end > window_start`),
    check("retro_check_2", sql`origin IN ('scheduled','manual')`),
    check("retro_check_4", sql`jsonb_typeof(repositories) = 'array'`),
    check(
      "retro_check_7",
      sql`state IN ('collecting','queued','generating','failed','published','abandoned','coverage_failed')`,
    ),
    check("retro_check_8", sql`digest_sha256 IS NULL OR length(digest_sha256) = 64`),
    check("retro_check_9", sql`manifest_sha256 IS NULL OR length(manifest_sha256) = 64`),
    check("retro_check_10", sql`attempt >= 0`),
    check(
      "retro_check_12",
      sql`state IN ('collecting','abandoned','coverage_failed') OR (digest_sha256 IS NOT NULL AND manifest_sha256 IS NOT NULL)`,
    ),
    check(
      "retro_check_13",
      sql`state <> 'published' OR (result IS NOT NULL AND result_sha256 IS NOT NULL)`,
    ),
  ],
);

export const retroRepository = pgTable(
  "retro_repository",
  {
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    repository: citext().notNull(),
    startCursor: bigint("start_cursor", { mode: "number" }).notNull(),
    endCursor: bigint("end_cursor", { mode: "number" }),
  },
  (table) => [
    primaryKey({
      columns: [table.retroId, table.repository],
      name: "retro_repository_retro_id_repository_pk",
    }),
    check("retro_repository_check_1", sql`end_cursor IS NULL OR end_cursor >= start_cursor`),
  ],
);

export const retroWatermark = pgTable(
  "retro_watermark",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    repository: citext().notNull(),
    cursor: bigint({ mode: "number" }).notNull(),
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.repository],
      name: "retro_watermark_workspace_id_repository_pk",
    }),
  ],
);

export const retroCollectionLock = pgTable(
  "retro_collection_lock",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    repository: citext().notNull(),
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    acquiredAt: bigint("acquired_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.repository],
      name: "retro_collection_lock_workspace_id_repository_pk",
    }),
  ],
);

export const retroAttempt = pgTable(
  "retro_attempt",
  {
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    attempt: bigint({ mode: "number" }).notNull(),
    owner: text().notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }).notNull(),
    finishedAt: bigint("finished_at", { mode: "number" }),
    outcome: text().notNull(),
    error: text(),
  },
  (table) => [
    primaryKey({
      columns: [table.retroId, table.attempt],
      name: "retro_attempt_retro_id_attempt_pk",
    }),
    check("retro_attempt_check_1", sql`attempt >= 1`),
    check("retro_attempt_check_2", sql`outcome IN ('running','failed','expired','succeeded')`),
  ],
);

export const retroEvidence = pgTable(
  "retro_evidence",
  {
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    evidenceId: text("evidence_id").notNull(),
    repository: citext().notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceRef: text("source_ref").notNull(),
    occurredAt: bigint("occurred_at", { mode: "number" }).notNull(),
    excerpt: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.retroId, table.evidenceId],
      name: "retro_evidence_retro_id_evidence_id_pk",
    }),
    check("retro_evidence_check_1", sql`length(evidence_id) BETWEEN 1 AND 200`),
    check("retro_evidence_check_2", sql`length(excerpt) <= 4000`),
  ],
);

export const retroCoverageGap = pgTable(
  "retro_coverage_gap",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    repository: citext(),
    kind: text().notNull(),
    detail: text().notNull(),
    recordedAt: bigint("recorded_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("retro_coverage_gap_retro").on(table.retroId),
    check(
      "retro_coverage_gap_check_1",
      sql`kind IN ('missing_artifact','hash_mismatch','retention_gap','source_unavailable')`,
    ),
    check("retro_coverage_gap_check_2", sql`length(detail) BETWEEN 1 AND 2000`),
  ],
);

export const retroArtifact = pgTable(
  "retro_artifact",
  {
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    kind: text().notNull(),
    sha256: text().notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    fileName: text("file_name").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.retroId, table.kind], name: "retro_artifact_retro_id_kind_pk" }),
    check("retro_artifact_check_1", sql`kind IN ('digest','manifest','prompt','report')`),
    check("retro_artifact_check_2", sql`length(sha256) = 64`),
    check("retro_artifact_check_3", sql`size_bytes >= 0`),
  ],
);

export const retroScheduleRuntime = pgTable("retro_schedule_runtime", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspace.id),
  lastOccurrenceAt: bigint("last_occurrence_at", { mode: "number" }),
  lastRetroId: text("last_retro_id").references(() => retro.id),
  nextDueAt: bigint("next_due_at", { mode: "number" }),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  blockedReason: text("blocked_reason"),
  blockedSince: bigint("blocked_since", { mode: "number" }),
});

export const retroItem = pgTable(
  "retro_item",
  {
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    itemId: text("item_id").notNull(),
    position: bigint({ mode: "number" }).notNull(),
    repository: citext().notNull(),
    area: text().notNull(),
    actionStep: text("action_step").notNull(),
    title: text().notNull(),
    problem: text().notNull(),
    proposedChange: text("proposed_change").notNull(),
    verificationCriterion: text("verification_criterion").notNull(),
    evidenceIds: jsonb("evidence_ids").notNull(),
    improvementId: text("improvement_id")
      .notNull()
      .references(() => improvement.id),
  },
  (table) => [
    primaryKey({ columns: [table.retroId, table.itemId], name: "retro_item_retro_id_item_id_pk" }),
    unique().on(table.retroId, table.position),
    check("retro_item_check_1", sql`length(item_id) BETWEEN 1 AND 100`),
    check("retro_item_check_2", sql`position >= 0`),
    check("retro_item_check_3", sql`length(area) BETWEEN 1 AND 200`),
    check(
      "retro_item_check_4",
      sql`action_step IN ('automatic','rule','convention','decision','issue')`,
    ),
    check("retro_item_check_5", sql`jsonb_typeof(evidence_ids) = 'array'`),
  ],
);

export const retroDispatch = pgTable(
  "retro_dispatch",
  {
    commandId: text("command_id").primaryKey(),
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    attempt: bigint({ mode: "number" }).notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    runnerFence: bigint("runner_fence", { mode: "number" }).notNull(),
    command: jsonb().notNull(),
    envelope: jsonb().notNull(),
    deliveries: bigint({ mode: "number" }).default(1).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    issuedAt: bigint("issued_at", { mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    fetchedAt: bigint("fetched_at", { mode: "number" }),
    acknowledgedAt: bigint("acknowledged_at", { mode: "number" }),
    cancelRequestedAt: bigint("cancel_requested_at", { mode: "number" }),
    result: jsonb(),
    resultAt: bigint("result_at", { mode: "number" }),
    releasedAt: bigint("released_at", { mode: "number" }),
    releaseReason: text("release_reason"),
    settledAt: bigint("settled_at", { mode: "number" }),
  },
  (table) => [
    unique().on(table.retroId, table.attempt),
    index("retro_dispatch_runner_open")
      .on(table.runnerId)
      .where(sql`released_at IS NULL`),
    index("retro_dispatch_unsettled")
      .on(table.retroId)
      .where(sql`settled_at IS NULL`),
    check("retro_dispatch_check_1", sql`attempt >= 1`),
    check("retro_dispatch_check_4", sql`deliveries >= 1`),
    check("retro_dispatch_check_5", sql`expires_at > issued_at`),
    check(
      "retro_dispatch_check_7",
      sql`release_reason IS NULL OR release_reason IN ('result','not_started','teardown')`,
    ),
    check("retro_dispatch_check_8", sql`(released_at IS NULL) = (release_reason IS NULL)`),
    check("retro_dispatch_check_9", sql`result IS NULL OR release_reason = 'result'`),
  ],
);

export const retroGeneration = pgTable(
  "retro_generation",
  {
    retroId: text("retro_id")
      .primaryKey()
      .references(() => retro.id),
    diagnostic: text().notNull(),
    detail: text().notNull(),
    since: bigint({ mode: "number" }).notNull(),
    until: bigint({ mode: "number" }),
    waitMs: bigint("wait_ms", { mode: "number" }).default(0).notNull(),
    activeMs: bigint("active_ms", { mode: "number" }).default(0).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  () => [
    check(
      "retro_generation_check_1",
      sql`diagnostic IN ('no_runner','capacity_wait','quota_cooldown','dispatched','active','unknown_outcome', 'retry_backoff','failed','ready')`,
    ),
    check("retro_generation_check_2", sql`length(detail) <= 2000`),
    check("retro_generation_check_3", sql`wait_ms >= 0`),
    check("retro_generation_check_4", sql`active_ms >= 0`),
  ],
);

export const retroOccurrence = pgTable(
  "retro_occurrence",
  {
    retroId: text("retro_id")
      .primaryKey()
      .references(() => retro.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    origin: text().notNull(),
    occurrenceAt: bigint("occurrence_at", { mode: "number" }).notNull(),
    windowStart: bigint("window_start", { mode: "number" }).notNull(),
    windowEnd: bigint("window_end", { mode: "number" }).notNull(),
    timeZone: text("time_zone").notNull(),
    localDate: text("local_date").notNull(),
    localTime: text("local_time").notNull(),
    utcOffsetMinutes: bigint("utc_offset_minutes", { mode: "number" }).notNull(),
    localAdjustment: text("local_adjustment").notNull(),
    settingsRevision: bigint("settings_revision", { mode: "number" }).notNull(),
    requestedBy: text("requested_by"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("retro_occurrence_scheduled")
      .on(table.workspaceId, table.occurrenceAt)
      .where(sql`origin = 'scheduled'`),
    check("retro_occurrence_check_1", sql`origin IN ('scheduled','manual')`),
    check("retro_occurrence_check_2", sql`window_end > window_start`),
    check(
      "retro_occurrence_check_3",
      sql`local_adjustment IN ('exact','skipped_forward','repeated_first')`,
    ),
  ],
);
