import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { run, workItem } from "./items";
import { workspace, workspaceUser } from "./workspace";
import { runner, runnerCommand } from "./runners";

export const browserInstallationRequest = pgTable("browser_installation_request", {
  stateHash: text("state_hash").primaryKey(),
  browserHash: text("browser_hash").notNull(),
  identity: text().notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});

export const agentCloseoutEvent = pgTable(
  "agent_closeout_event",
  {
    runId: text("run_id").notNull(),
    sequence: bigint({ mode: "number" }).notNull(),
    itemId: text("item_id").notNull(),
    at: bigint({ mode: "number" }).notNull(),
    type: text().notNull(),
    head: text().notNull(),
    maxAttempts: bigint("max_attempts", { mode: "number" }),
    checkId: text("check_id"),
    kind: text(),
    command: text(),
    attempt: bigint({ mode: "number" }),
    state: text(),
    exitCode: bigint("exit_code", { mode: "number" }),
    timedOut: integer("timed_out").default(0).notNull(),
    durationMs: bigint("duration_ms", { mode: "number" }),
    stdout: text().default("").notNull(),
    stderr: text().default("").notNull(),
    truncated: integer().default(0).notNull(),
    checks: text(),
    blocked: text(),
    base: text(),
    policyDigest: text("policy_digest"),
    clean: bigint({ mode: "number" }),
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

export const agentSkill = pgTable(
  "agent_skill",
  {
    name: text().primaryKey(),
    source: jsonb().notNull(),
    version: text().notNull(),
    sha256: text().notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    agents: jsonb().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    removedAt: bigint("removed_at", { mode: "number" }),
  },
  () => [
    check("agent_skill_check_1", sql`length(name) BETWEEN 1 AND 64`),
    check("agent_skill_check_3", sql`length(version) BETWEEN 1 AND 128`),
    check("agent_skill_check_4", sql`length(sha256)=64`),
    check("agent_skill_check_5", sql`size_bytes>0`),
  ],
);

export const agentHook = pgTable(
  "agent_hook",
  {
    id: text().primaryKey(),
    event: text().notNull(),
    matcher: text(),
    command: text().notNull(),
    timeoutSeconds: bigint("timeout_seconds", { mode: "number" }).notNull(),
    agents: jsonb().notNull(),
    skill: text(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  () => [
    check(
      "agent_hook_check_1",
      sql`event IN ('after_edit','before_shell','before_tool','stop','session_start')`,
    ),
    check("agent_hook_check_2", sql`matcher IS NULL OR length(matcher) BETWEEN 1 AND 256`),
    check("agent_hook_check_3", sql`length(command) BETWEEN 1 AND 4096`),
    check("agent_hook_check_4", sql`timeout_seconds BETWEEN 1 AND 600`),
  ],
);

export const npmPackage = pgTable("npm_package", {
  package: text().primaryKey(),
  etag: text(),
  fetchedAt: bigint("fetched_at", { mode: "number" }).notNull(),
  versions: jsonb().notNull(),
});

export const npmPackageVersion = pgTable(
  "npm_package_version",
  {
    package: text().notNull(),
    version: text().notNull(),
    integrity: text().notNull(),
    firstSeenAt: bigint("first_seen_at", { mode: "number" }).notNull(),
    changedIntegrity: text("changed_integrity"),
    changedAt: bigint("changed_at", { mode: "number" }),
  },
  (table) => [
    primaryKey({
      columns: [table.package, table.version],
      name: "npm_package_version_package_version_pk",
    }),
  ],
);

export const agentVersion = pgTable(
  "agent_version",
  {
    agent: text().notNull(),
    version: text().notNull(),
    publishedAt: bigint("published_at", { mode: "number" }),
    integrity: text().notNull(),
    status: text().notNull(),
    firstSeenAt: bigint("first_seen_at", { mode: "number" }).notNull(),
    reason: text(),
    nativeVersion: text("native_version"),
    checkedAt: bigint("checked_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.agent, table.version], name: "agent_version_agent_version_pk" }),
    check("agent_version_check_1", sql`status IN ('eligible','waiting','ineligible','refused')`),
  ],
);

export const agentCatalogRefresh = pgTable(
  "agent_catalog_refresh",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    completedAt: bigint("completed_at", { mode: "number" }).notNull(),
  },
  () => [check("agent_catalog_refresh_check_1", sql`id = 1`)],
);

export const agentSessionSnapshot = pgTable(
  "agent_session_snapshot",
  {
    runId: text("run_id")
      .notNull()
      .references(() => run.id),
    generation: bigint({ mode: "number" }).notNull(),
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
    turn: bigint({ mode: "number" }),
    sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
    sealedSize: bigint("sealed_size", { mode: "number" }),
    sha256: text(),
    status: text().default("uploading").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    sealedAt: bigint("sealed_at", { mode: "number" }),
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

export const agentSessionSnapshotChunk = pgTable(
  "agent_session_snapshot_chunk",
  {
    runId: text("run_id").notNull(),
    generation: bigint({ mode: "number" }).notNull(),
    offset: bigint({ mode: "number" }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text().notNull(),
    keyId: text("key_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.generation, table.offset],
      name: "agent_session_snapshot_chunk_run_id_generation_offset_pk",
    }),
    foreignKey({
      columns: [table.runId, table.generation],
      foreignColumns: [agentSessionSnapshot.runId, agentSessionSnapshot.generation],
      name: "agent_session_snapshot_chunk_run_id_generation_agent_session_snapshot_run_id_generation_fk",
    }),
    check("agent_session_snapshot_chunk_check_1", sql`"offset">=0 AND "offset"%524288=0`),
    check("agent_session_snapshot_chunk_check_2", sql`size_bytes BETWEEN 1 AND 524288`),
    check("agent_session_snapshot_chunk_check_3", sql`length(sha256)=64`),
    check("agent_session_snapshot_chunk_check_4", sql`length(key_id)=64`),
  ],
);

export const agentModelCatalog = pgTable(
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
    resultJson: jsonb("result_json").notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runnerId, table.userId, table.agent, table.model],
      name: "agent_model_catalog_runner_id_user_id_agent_model_pk",
    }),
    check("agent_model_catalog_check_1", sql`agent IN ('claude','codex','grok','opencode')`),
  ],
);

export const agentModelProbe = pgTable(
  "agent_model_probe",
  {
    commandId: text("command_id")
      .primaryKey()
      .references(() => runnerCommand.id),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    userId: text("user_id")
      .notNull()
      .references(() => workspaceUser.id),
    agent: text().notNull(),
    model: text().notNull(),
    requestedAt: bigint("requested_at", { mode: "number" }).notNull(),
    finishedAt: bigint("finished_at", { mode: "number" }),
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

export const agentWait = pgTable("agent_wait", {
  runId: text("run_id")
    .primaryKey()
    .references(() => run.id, { onDelete: "cascade" }),
  generation: bigint({ mode: "number" }).notNull(),
  startedAt: bigint("started_at", { mode: "number" }).notNull(),
  waitingMs: bigint("waiting_ms", { mode: "number" }).notNull(),
});
