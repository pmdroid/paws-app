import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { run, workItem } from "./items";
import { runner, runnerCommand } from "./runners";
import { workspace, workspaceUser } from "./workspace";

export const browserInstallationRequest = sqliteTable("browser_installation_request", {
  stateHash: text("state_hash").primaryKey().notNull(),
  browserHash: text("browser_hash").notNull(),
  identity: text().notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const agentCloseoutEvent = sqliteTable(
  "agent_closeout_event",
  {
    runId: text("run_id").notNull(),
    sequence: integer().notNull(),
    itemId: text("item_id").notNull(),
    at: integer().notNull(),
    type: text().notNull(),
    head: text().notNull(),
    maxAttempts: integer("max_attempts"),
    checkId: text("check_id"),
    kind: text(),
    command: text(),
    attempt: integer(),
    state: text(),
    exitCode: integer("exit_code"),
    timedOut: integer("timed_out").default(0).notNull(),
    durationMs: integer("duration_ms"),
    stdout: text().default("").notNull(),
    stderr: text().default("").notNull(),
    truncated: integer().default(0).notNull(),
    checks: text(),
    blocked: text(),
    base: text(),
    policyDigest: text("policy_digest"),
    clean: integer(),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.sequence],
      name: "agent_closeout_event_run_id_sequence_pk",
    }),
    index("agent_closeout_event_item").on(table.itemId, table.runId),
    check("agent_closeout_event_check_1", sql`sequence > 0`),
    check("agent_closeout_event_check_2", sql`type IN ('report', 'started', 'finished')`),
    check(
      "agent_closeout_event_check_3",
      sql`state IS NULL OR state IN ('passed', 'failed', 'exhausted', 'cancelled')`,
    ),
    check("agent_closeout_event_check_4", sql`timed_out IN (0, 1)`),
    check("agent_closeout_event_check_5", sql`truncated IN (0, 1)`),
    check("agent_closeout_event_check_6", sql`clean IS NULL OR clean IN (0, 1)`),
  ],
);

export const agentSkill = sqliteTable(
  "agent_skill",
  {
    name: text().primaryKey().notNull(),
    source: text().notNull(),
    version: text().notNull(),
    sha256: text().notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    agents: text().notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    removedAt: integer("removed_at"),
  },
  () => [
    check("agent_skill_check_1", sql`length(name) BETWEEN 1 AND 64`),
    check("agent_skill_check_2", sql`json_valid(source)`),
    check("agent_skill_check_3", sql`length(version) BETWEEN 1 AND 128`),
    check("agent_skill_check_4", sql`length(sha256)=64`),
    check("agent_skill_check_5", sql`size_bytes>0`),
    check("agent_skill_check_6", sql`json_valid(agents)`),
  ],
);

export const agentHook = sqliteTable(
  "agent_hook",
  {
    id: text().primaryKey().notNull(),
    event: text().notNull(),
    matcher: text(),
    command: text().notNull(),
    timeoutSeconds: integer("timeout_seconds").notNull(),
    agents: text().notNull(),
    skill: text(),
    createdAt: integer("created_at").notNull(),
  },
  () => [
    check(
      "agent_hook_check_1",
      sql`event IN ('after_edit','before_shell','before_tool','stop','session_start')`,
    ),
    check("agent_hook_check_2", sql`matcher IS NULL OR length(matcher) BETWEEN 1 AND 256`),
    check("agent_hook_check_3", sql`length(command) BETWEEN 1 AND 4096`),
    check("agent_hook_check_4", sql`timeout_seconds BETWEEN 1 AND 600`),
    check("agent_hook_check_5", sql`json_valid(agents)`),
  ],
);

export const npmPackage = sqliteTable(
  "npm_package",
  {
    package: text().primaryKey().notNull(),
    etag: text(),
    fetchedAt: integer("fetched_at").notNull(),
    versions: text().notNull(),
  },
  () => [check("npm_package_check_1", sql`json_valid(versions)`)],
);

export const npmPackageVersion = sqliteTable(
  "npm_package_version",
  {
    package: text().notNull(),
    version: text().notNull(),
    integrity: text().notNull(),
    firstSeenAt: integer("first_seen_at").notNull(),
    changedIntegrity: text("changed_integrity"),
    changedAt: integer("changed_at"),
  },
  (table) => [
    primaryKey({
      columns: [table.package, table.version],
      name: "npm_package_version_package_version_pk",
    }),
  ],
);

export const agentVersion = sqliteTable(
  "agent_version",
  {
    agent: text().notNull(),
    version: text().notNull(),
    publishedAt: integer("published_at"),
    integrity: text().notNull(),
    status: text().notNull(),
    firstSeenAt: integer("first_seen_at").notNull(),
    reason: text(),
    nativeVersion: text("native_version"),
    checkedAt: integer("checked_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agent, table.version], name: "agent_version_agent_version_pk" }),
    check("agent_version_check_1", sql`status IN ('eligible','waiting','ineligible','refused')`),
  ],
);

export const agentCatalogRefresh = sqliteTable(
  "agent_catalog_refresh",
  {
    id: integer().primaryKey(),
    completedAt: integer("completed_at").notNull(),
  },
  () => [check("agent_catalog_refresh_check_1", sql`id = 1`)],
);

export const agentSessionSnapshot = sqliteTable(
  "agent_session_snapshot",
  {
    runId: text("run_id")
      .notNull()
      .references(() => run.id),
    generation: integer().notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    ownerUserId: text("owner_user_id").references(() => workspaceUser.id),
    agent: text(),
    agentVersion: text("agent_version"),
    sessionId: text("session_id"),
    workspacePath: text("workspace_path"),
    commitSha: text("commit_sha"),
    turn: integer(),
    sizeBytes: integer("size_bytes").default(0).notNull(),
    sealedSize: integer("sealed_size"),
    sha256: text(),
    status: text().default("uploading").notNull(),
    createdAt: integer("created_at").notNull(),
    sealedAt: integer("sealed_at"),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.generation],
      name: "agent_session_snapshot_run_id_generation_pk",
    }),
    check("agent_session_snapshot_check_1", sql`generation>0`),
    check(
      "agent_session_snapshot_check_2",
      sql`agent IS NULL OR agent IN ('claude','codex','grok')`,
    ),
    check("agent_session_snapshot_check_3", sql`turn IS NULL OR turn>=0`),
    check("agent_session_snapshot_check_4", sql`size_bytes BETWEEN 0 AND 1073741824`),
    check("agent_session_snapshot_check_5", sql`sealed_size IS NULL OR sealed_size=size_bytes`),
    check("agent_session_snapshot_check_6", sql`sha256 IS NULL OR length(sha256)=64`),
    check("agent_session_snapshot_check_7", sql`status IN ('uploading','sealed','discarded')`),
    check(
      "agent_session_snapshot_check_8",
      sql`status<>'sealed' OR (owner_user_id IS NOT NULL AND agent IS NOT NULL AND agent_version IS NOT NULL AND session_id IS NOT NULL AND workspace_path IS NOT NULL AND commit_sha IS NOT NULL AND turn IS NOT NULL AND sealed_size IS NOT NULL AND sha256 IS NOT NULL AND sealed_at IS NOT NULL)`,
    ),
  ],
);

export const agentSessionSnapshotChunk = sqliteTable(
  "agent_session_snapshot_chunk",
  {
    runId: text("run_id").notNull(),
    generation: integer().notNull(),
    offset: integer().notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text().notNull(),
    keyId: text("key_id").notNull(),
  },
  (table) => [
    foreignKey(() => ({
      columns: [table.runId, table.generation],
      foreignColumns: [agentSessionSnapshot.runId, agentSessionSnapshot.generation],
      name: "agent_session_snapshot_chunk_run_id_generation_agent_session_snapshot_run_id_generation_fk",
    })),
    primaryKey({
      columns: [table.runId, table.generation, table.offset],
      name: "agent_session_snapshot_chunk_run_id_generation_offset_pk",
    }),
    check("agent_session_snapshot_chunk_check_1", sql`offset>=0 AND offset%524288=0`),
    check("agent_session_snapshot_chunk_check_2", sql`size_bytes BETWEEN 1 AND 524288`),
    check("agent_session_snapshot_chunk_check_3", sql`length(sha256)=64`),
    check("agent_session_snapshot_chunk_check_4", sql`length(key_id)=64`),
  ],
);

export const agentModelCatalog = sqliteTable(
  "agent_model_catalog",
  {
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    userId: text("user_id")
      .notNull()
      .references(() => workspaceUser.id),
    agent: text().notNull(),
    model: text().notNull(),
    resultJson: text("result_json").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runnerId, table.userId, table.agent, table.model],
      name: "agent_model_catalog_runner_id_user_id_agent_model_pk",
    }),
    check("agent_model_catalog_check_1", sql`agent IN ('claude','codex','grok','opencode')`),
    check("agent_model_catalog_check_2", sql`json_valid(result_json)`),
  ],
);

export const agentModelProbe = sqliteTable(
  "agent_model_probe",
  {
    commandId: text("command_id")
      .primaryKey()
      .notNull()
      .references(() => runnerCommand.id),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    userId: text("user_id")
      .notNull()
      .references(() => workspaceUser.id),
    agent: text().notNull(),
    model: text().notNull(),
    requestedAt: integer("requested_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (table) => [
    uniqueIndex("agent_model_probe_pending")
      .on(table.runnerId)
      .where(sql`finished_at IS NULL`),
    index("agent_model_probe_refresh").on(
      table.runnerId,
      table.userId,
      table.agent,
      table.model,
      table.requestedAt,
    ),
    check("agent_model_probe_check_1", sql`agent IN ('claude','codex','grok','opencode')`),
  ],
);

export const agentWait = sqliteTable("agent_wait", {
  runId: text("run_id")
    .primaryKey()
    .notNull()
    .references(() => run.id, { onDelete: "cascade" }),
  generation: integer().notNull(),
  startedAt: integer("started_at").notNull(),
  waitingMs: integer("waiting_ms").notNull(),
});
