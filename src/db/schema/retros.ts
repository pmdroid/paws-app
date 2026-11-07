import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { improvement } from "./improvements";
import { runner } from "./runners";
import { workspace } from "./workspace";

export const retroSettingsRevision = sqliteTable(
  "retro_settings_revision",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    revision: integer().notNull(),
    prompt: text().notNull(),
    agentProfile: text("agent_profile").notNull(),
    repositories: text().notNull(),
    outputLimits: text("output_limits").notNull(),
    executionLimits: text("execution_limits").notNull(),
    schedule: text().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.revision],
      name: "retro_settings_revision_workspace_id_revision_pk",
    }),
    check("retro_settings_revision_check_1", sql`revision >= 1`),
    check("retro_settings_revision_check_2", sql`length(prompt) BETWEEN 1 AND 16000`),
    check("retro_settings_revision_check_3", sql`json_valid(agent_profile)`),
    check(
      "retro_settings_revision_check_4",
      sql`json_valid(repositories) AND json_type(repositories) = 'array'`,
    ),
    check("retro_settings_revision_check_5", sql`json_valid(output_limits)`),
    check("retro_settings_revision_check_6", sql`json_valid(execution_limits)`),
    check("retro_settings_revision_check_7", sql`json_valid(schedule)`),
  ],
);

export const retro = sqliteTable(
  "retro",
  {
    id: text().primaryKey().notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    windowStart: integer("window_start").notNull(),
    windowEnd: integer("window_end").notNull(),
    origin: text().notNull(),
    scheduledFor: integer("scheduled_for"),
    settingsRevision: integer("settings_revision").notNull(),
    prompt: text().notNull(),
    agentProfile: text("agent_profile").notNull(),
    repositories: text().notNull(),
    outputLimits: text("output_limits").notNull(),
    executionLimits: text("execution_limits").notNull(),
    state: text().notNull(),
    digestSha256: text("digest_sha256"),
    manifestSha256: text("manifest_sha256"),
    attempt: integer().default(0).notNull(),
    owner: text(),
    ownerExpiresAt: integer("owner_expires_at"),
    result: text(),
    resultSha256: text("result_sha256"),
    error: text(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    publishedAt: integer("published_at"),
  },
  (table) => [
    foreignKey(() => ({
      columns: [table.workspaceId, table.settingsRevision],
      foreignColumns: [retroSettingsRevision.workspaceId, retroSettingsRevision.revision],
      name: "retro_workspace_id_settings_revision_retro_settings_revision_workspace_id_revision_fk",
    })),
    unique().on(table.workspaceId, table.windowStart, table.windowEnd),
    index("retro_workspace").on(table.workspaceId, table.windowEnd),
    check("retro_check_1", sql`window_end > window_start`),
    check("retro_check_2", sql`origin IN ('scheduled','manual')`),
    check("retro_check_3", sql`json_valid(agent_profile)`),
    check("retro_check_4", sql`json_valid(repositories) AND json_type(repositories) = 'array'`),
    check("retro_check_5", sql`json_valid(output_limits)`),
    check("retro_check_6", sql`json_valid(execution_limits)`),
    check(
      "retro_check_7",
      sql`state IN ('collecting','queued','generating','failed','published','abandoned','coverage_failed')`,
    ),
    check("retro_check_8", sql`digest_sha256 IS NULL OR length(digest_sha256) = 64`),
    check("retro_check_9", sql`manifest_sha256 IS NULL OR length(manifest_sha256) = 64`),
    check("retro_check_10", sql`attempt >= 0`),
    check("retro_check_11", sql`result IS NULL OR json_valid(result)`),
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

export const retroRepository = sqliteTable(
  "retro_repository",
  {
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    repository: text().notNull(),
    startCursor: integer("start_cursor").notNull(),
    endCursor: integer("end_cursor"),
  },
  (table) => [
    primaryKey({
      columns: [table.retroId, table.repository],
      name: "retro_repository_retro_id_repository_pk",
    }),
    check("retro_repository_check_1", sql`end_cursor IS NULL OR end_cursor >= start_cursor`),
  ],
);

export const retroWatermark = sqliteTable(
  "retro_watermark",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    repository: text().notNull(),
    cursor: integer().notNull(),
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.repository],
      name: "retro_watermark_workspace_id_repository_pk",
    }),
  ],
);

export const retroCollectionLock = sqliteTable(
  "retro_collection_lock",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    repository: text().notNull(),
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    acquiredAt: integer("acquired_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.repository],
      name: "retro_collection_lock_workspace_id_repository_pk",
    }),
  ],
);

export const retroAttempt = sqliteTable(
  "retro_attempt",
  {
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    attempt: integer().notNull(),
    owner: text().notNull(),
    startedAt: integer("started_at").notNull(),
    leaseExpiresAt: integer("lease_expires_at").notNull(),
    finishedAt: integer("finished_at"),
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

export const retroEvidence = sqliteTable(
  "retro_evidence",
  {
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    evidenceId: text("evidence_id").notNull(),
    repository: text().notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceRef: text("source_ref").notNull(),
    occurredAt: integer("occurred_at").notNull(),
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

export const retroCoverageGap = sqliteTable(
  "retro_coverage_gap",
  {
    id: integer().primaryKey(),
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    repository: text(),
    kind: text().notNull(),
    detail: text().notNull(),
    recordedAt: integer("recorded_at").notNull(),
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

export const retroArtifact = sqliteTable(
  "retro_artifact",
  {
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    kind: text().notNull(),
    sha256: text().notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    fileName: text("file_name").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.retroId, table.kind], name: "retro_artifact_retro_id_kind_pk" }),
    check("retro_artifact_check_1", sql`kind IN ('digest','manifest','prompt','report')`),
    check("retro_artifact_check_2", sql`length(sha256) = 64`),
    check("retro_artifact_check_3", sql`size_bytes >= 0`),
  ],
);

export const retroScheduleRuntime = sqliteTable("retro_schedule_runtime", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .notNull()
    .references(() => workspace.id),
  lastOccurrenceAt: integer("last_occurrence_at"),
  lastRetroId: text("last_retro_id").references(() => retro.id),
  nextDueAt: integer("next_due_at"),
  updatedAt: integer("updated_at").notNull(),
  blockedReason: text("blocked_reason"),
  blockedSince: integer("blocked_since"),
});

export const retroItem = sqliteTable(
  "retro_item",
  {
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    itemId: text("item_id").notNull(),
    position: integer().notNull(),
    repository: text().notNull(),
    area: text().notNull(),
    actionStep: text("action_step").notNull(),
    title: text().notNull(),
    problem: text().notNull(),
    proposedChange: text("proposed_change").notNull(),
    verificationCriterion: text("verification_criterion").notNull(),
    evidenceIds: text("evidence_ids").notNull(),
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
    check(
      "retro_item_check_5",
      sql`json_valid(evidence_ids) AND json_type(evidence_ids) = 'array'`,
    ),
  ],
);

export const retroDispatch = sqliteTable(
  "retro_dispatch",
  {
    commandId: text("command_id").primaryKey().notNull(),
    retroId: text("retro_id")
      .notNull()
      .references(() => retro.id),
    attempt: integer().notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    runnerFence: integer("runner_fence").notNull(),
    command: text().notNull(),
    envelope: text().notNull(),
    deliveries: integer().default(1).notNull(),
    createdAt: integer("created_at").notNull(),
    issuedAt: integer("issued_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    fetchedAt: integer("fetched_at"),
    acknowledgedAt: integer("acknowledged_at"),
    cancelRequestedAt: integer("cancel_requested_at"),
    result: text(),
    resultAt: integer("result_at"),
    releasedAt: integer("released_at"),
    releaseReason: text("release_reason"),
    settledAt: integer("settled_at"),
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
    check("retro_dispatch_check_2", sql`json_valid(command)`),
    check("retro_dispatch_check_3", sql`json_valid(envelope)`),
    check("retro_dispatch_check_4", sql`deliveries >= 1`),
    check("retro_dispatch_check_5", sql`expires_at > issued_at`),
    check("retro_dispatch_check_6", sql`result IS NULL OR json_valid(result)`),
    check(
      "retro_dispatch_check_7",
      sql`release_reason IS NULL OR release_reason IN ('result','not_started','teardown')`,
    ),
    check("retro_dispatch_check_8", sql`(released_at IS NULL) = (release_reason IS NULL)`),
    check("retro_dispatch_check_9", sql`result IS NULL OR release_reason = 'result'`),
  ],
);

export const retroGeneration = sqliteTable(
  "retro_generation",
  {
    retroId: text("retro_id")
      .primaryKey()
      .notNull()
      .references(() => retro.id),
    diagnostic: text().notNull(),
    detail: text().notNull(),
    since: integer().notNull(),
    until: integer(),
    waitMs: integer("wait_ms").default(0).notNull(),
    activeMs: integer("active_ms").default(0).notNull(),
    updatedAt: integer("updated_at").notNull(),
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

export const retroOccurrence = sqliteTable(
  "retro_occurrence",
  {
    retroId: text("retro_id")
      .primaryKey()
      .notNull()
      .references(() => retro.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    origin: text().notNull(),
    occurrenceAt: integer("occurrence_at").notNull(),
    windowStart: integer("window_start").notNull(),
    windowEnd: integer("window_end").notNull(),
    timeZone: text("time_zone").notNull(),
    localDate: text("local_date").notNull(),
    localTime: text("local_time").notNull(),
    utcOffsetMinutes: integer("utc_offset_minutes").notNull(),
    localAdjustment: text("local_adjustment").notNull(),
    settingsRevision: integer("settings_revision").notNull(),
    requestedBy: text("requested_by"),
    createdAt: integer("created_at").notNull(),
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
