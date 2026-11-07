import {
  bigint,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace, workspaceMember, workspaceUser } from "./workspace";
import { run, workItem } from "./items";
import { linearSession } from "./linear";
import { agentAccountBinding } from "./accounts";

export const runner = pgTable(
  "runner",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    name: text().notNull(),
    status: text().notNull(),
    fence: bigint({ mode: "number" }).default(0).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    revokedAt: bigint("revoked_at", { mode: "number" }),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }),
    liveReportedAt: bigint("live_reported_at", { mode: "number" }),
    terminationsSince: bigint("terminations_since", { mode: "number" }),
  },
  (table) => [
    foreignKey({
      columns: [table.workspaceId, table.ownerUserId],
      foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
      name: "runner_workspace_id_owner_user_id_workspace_member_workspace_id_user_id_fk",
    }),
    check("runner_check_1", sql`status IN ('active','paused','draining','revoked')`),
    check("runner_check_2", sql`fence >= 0`),
  ],
);

export const runnerCertificate = pgTable(
  "runner_certificate",
  {
    fingerprint: text().primaryKey(),
    serial: text().notNull(),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    pem: text().notNull(),
    notBefore: bigint("not_before", { mode: "number" }).notNull(),
    notAfter: bigint("not_after", { mode: "number" }).notNull(),
    acceptedUntil: bigint("accepted_until", { mode: "number" }).notNull(),
    revokedAt: bigint("revoked_at", { mode: "number" }),
  },
  (table) => [unique().on(table.serial), index("runner_certificate_identity").on(table.runnerId)],
);

export const runnerWork = pgTable(
  "runner_work",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => run.id),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    generation: bigint({ mode: "number" }).notNull(),
    runnerFence: bigint("runner_fence", { mode: "number" }).notNull(),
    commandId: text("command_id").notNull(),
    leaseUntil: bigint("lease_until", { mode: "number" }).notNull(),
    lastSequence: bigint("last_sequence", { mode: "number" }).default(0).notNull(),
    endedAt: bigint("ended_at", { mode: "number" }),
    consumedSequence: bigint("consumed_sequence", { mode: "number" }).default(0).notNull(),
    confirmedAt: bigint("confirmed_at", { mode: "number" }),
    lostAt: bigint("lost_at", { mode: "number" }),
    teardownConfirmedAt: bigint("teardown_confirmed_at", { mode: "number" }),
  },
  (table) => [
    unique().on(table.commandId),
    check("runner_work_check_1", sql`generation>0`),
    check("runner_work_check_2", sql`runner_fence>=0`),
    check("runner_work_check_3", sql`last_sequence>=0`),
    check("runner_work_check_4", sql`consumed_sequence>=0`),
  ],
);

export const runnerWorkGrant = pgTable("runner_work_grant", {
  tokenHash: text("token_hash").primaryKey(),
  runId: text("run_id")
    .notNull()
    .references(() => runnerWork.runId),
  generation: bigint({ mode: "number" }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});

export const runnerEvent = pgTable(
  "runner_event",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runnerWork.runId),
    generation: bigint({ mode: "number" }).notNull(),
    sequence: bigint({ mode: "number" }).notNull(),
    payload: jsonb().notNull(),
    receivedAt: bigint("received_at", { mode: "number" }).notNull(),
    keyId: text("key_id"),
    payloadSha256: text("payload_sha256"),
    type: text(),
    handedOver: bigint("handed_over", { mode: "number" }),
    reason: text(),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.generation, table.sequence],
      name: "runner_event_run_id_generation_sequence_pk",
    }),
    index("runner_event_type").on(table.runId, table.generation, table.type),
    check("runner_event_check_1", sql`sequence>0`),
  ],
);

export const runnerResult = pgTable(
  "runner_result",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runnerWork.runId),
    generation: bigint({ mode: "number" }).notNull(),
    commandId: text("command_id")
      .notNull()
      .references(() => runnerCommand.id),
    payload: jsonb().notNull(),
    receivedAt: bigint("received_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.generation],
      name: "runner_result_run_id_generation_pk",
    }),
    check("runner_result_check_1", sql`generation>0`),
  ],
);

export const runnerQuestionAnswer = pgTable(
  "runner_question_answer",
  {
    runId: text("run_id").notNull(),
    generation: bigint({ mode: "number" }).notNull(),
    sequence: bigint({ mode: "number" }).notNull(),
    answer: text().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.generation, table.sequence],
      name: "runner_question_answer_run_id_generation_sequence_pk",
    }),
    foreignKey({
      columns: [table.runId, table.generation, table.sequence],
      foreignColumns: [runnerEvent.runId, runnerEvent.generation, runnerEvent.sequence],
      name: "runner_question_answer_run_id_generation_sequence_runner_event_run_id_generation_sequence_fk",
    }),
  ],
);

export const runnerHealthResult = pgTable("runner_health_result", {
  commandId: text("command_id")
    .primaryKey()
    .references(() => runnerCommand.id),
  runnerId: text("runner_id")
    .notNull()
    .references(() => runner.id),
  resultJson: text("result_json").notNull(),
  receivedAt: bigint("received_at", { mode: "number" }).notNull(),
});

export const runnerTranscript = pgTable(
  "runner_transcript",
  {
    runId: text("run_id")
      .notNull()
      .references(() => run.id),
    generation: bigint({ mode: "number" }).notNull(),
    commandId: text("command_id")
      .notNull()
      .references(() => runnerCommand.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    executionId: text("execution_id").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
    sealedSize: bigint("sealed_size", { mode: "number" }),
    sha256: text(),
    uri: text(),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.generation],
      name: "runner_transcript_run_id_generation_pk",
    }),
    unique().on(table.commandId),
    check("runner_transcript_check_1", sql`generation>0`),
    check("runner_transcript_check_2", sql`size_bytes BETWEEN 0 AND 16777216`),
    check("runner_transcript_check_3", sql`sealed_size IS NULL OR sealed_size=size_bytes`),
    check("runner_transcript_check_4", sql`sha256 IS NULL OR length(sha256)=64`),
  ],
);

export const runnerTranscriptChunk = pgTable(
  "runner_transcript_chunk",
  {
    runId: text("run_id").notNull(),
    generation: bigint({ mode: "number" }).notNull(),
    offset: bigint({ mode: "number" }).notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text().notNull(),
    keyId: text("key_id"),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.generation, table.offset],
      name: "runner_transcript_chunk_run_id_generation_offset_pk",
    }),
    foreignKey({
      columns: [table.runId, table.generation],
      foreignColumns: [runnerTranscript.runId, runnerTranscript.generation],
      name: "runner_transcript_chunk_run_id_generation_runner_transcript_run_id_generation_fk",
    }),
    check("runner_transcript_chunk_check_1", sql`"offset">=0`),
    check("runner_transcript_chunk_check_2", sql`size_bytes BETWEEN 1 AND 524288`),
    check("runner_transcript_chunk_check_3", sql`length(sha256)=64`),
    check("runner_transcript_chunk_check_4", sql`key_id IS NULL OR length(key_id)=64`),
  ],
);

export const runnerHelper = pgTable(
  "runner_helper",
  {
    id: text().primaryKey(),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => linearSession.sessionId),
    sessionGeneration: bigint("session_generation", { mode: "number" }).notNull(),
    runnerFence: bigint("runner_fence", { mode: "number" }).notNull(),
    envelope: jsonb().notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    acknowledgedAt: bigint("acknowledged_at", { mode: "number" }),
    endedAt: bigint("ended_at", { mode: "number" }),
    result: jsonb(),
  },
  (table) => [
    index("runner_helper_pending").on(table.runnerId, table.acknowledgedAt, table.expiresAt),
  ],
);

export const runnerPolicy = pgTable(
  "runner_policy",
  {
    runnerId: text("runner_id")
      .primaryKey()
      .references(() => runner.id),
    hostOwner: text("host_owner").default("unknown").notNull(),
    sharing: integer().default(0).notNull(),
    fallback: integer().default(0).notNull(),
  },
  () => [
    check("runner_policy_check_1", sql`host_owner IN ('member','workspace','unknown')`),
    check("runner_policy_check_2", sql`sharing IN (0,1)`),
    check("runner_policy_check_3", sql`fallback IN (0,1)`),
  ],
);

export const runnerCapacity = pgTable(
  "runner_capacity",
  {
    runnerId: text("runner_id")
      .primaryKey()
      .references(() => runner.id),
    capacity: bigint({ mode: "number" }).notNull(),
    ceiling: bigint({ mode: "number" }),
    desired: bigint({ mode: "number" }),
  },
  () => [
    check("runner_capacity_check_1", sql`capacity BETWEEN 1 AND 16`),
    check("runner_capacity_check_2", sql`ceiling IS NULL OR ceiling BETWEEN 1 AND 16`),
    check("runner_capacity_check_3", sql`desired IS NULL OR desired BETWEEN 1 AND 16`),
  ],
);

export const runnerReservation = pgTable(
  "runner_reservation",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => run.id),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    instanceId: text("instance_id").notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  },
  (table) => [index("runner_reservation_runner").on(table.runnerId, table.expiresAt)],
);

export const runnerHostStatus = pgTable(
  "runner_host_status",
  {
    runnerId: text("runner_id")
      .primaryKey()
      .references(() => runner.id),
    cpuPercent: doublePrecision("cpu_percent"),
    memoryTotalBytes: bigint("memory_total_bytes", { mode: "number" }),
    memoryAvailableBytes: bigint("memory_available_bytes", { mode: "number" }),
    load1: doublePrecision("load_1"),
    load5: doublePrecision("load_5"),
    load15: doublePrecision("load_15"),
    diskTotalBytes: bigint("disk_total_bytes", { mode: "number" }),
    diskFreeBytes: bigint("disk_free_bytes", { mode: "number" }),
    osId: text("os_id"),
    osVersion: text("os_version"),
    runnerVersion: text("runner_version"),
    reportedAt: bigint("reported_at", { mode: "number" }).notNull(),
    cpuCount: bigint("cpu_count", { mode: "number" }),
    strayProcesses: text("stray_processes"),
    miseVersion: text("mise_version"),
    agentUser: text("agent_user"),
  },
  () => [
    check("runner_host_status_check_1", sql`cpu_percent BETWEEN 0 AND 100`),
    check("runner_host_status_check_2", sql`memory_total_bytes>=0`),
    check("runner_host_status_check_3", sql`memory_available_bytes>=0`),
    check("runner_host_status_check_4", sql`load_1>=0`),
    check("runner_host_status_check_5", sql`load_5>=0`),
    check("runner_host_status_check_6", sql`load_15>=0`),
    check("runner_host_status_check_7", sql`disk_total_bytes>=0`),
    check("runner_host_status_check_8", sql`disk_free_bytes>=0`),
    check("runner_host_status_check_9", sql`cpu_count>=1`),
    check("runner_host_status_check_10", sql`agent_user IN ('runner','paws-agent')`),
  ],
);

export const runnerFollowUp = pgTable(
  "runner_follow_up",
  {
    runId: text("run_id").notNull(),
    generation: bigint({ mode: "number" }).notNull(),
    sequence: bigint({ mode: "number" }).notNull(),
    body: text().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.generation, table.sequence],
      name: "runner_follow_up_run_id_generation_sequence_pk",
    }),
    check("runner_follow_up_check_1", sql`sequence>0`),
  ],
);

export const runnerAgentUsage = pgTable(
  "runner_agent_usage",
  {
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id, { onDelete: "cascade" }),
    agent: text().notNull(),
    limitsJson: text("limits_json").notNull(),
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runnerId, table.agent],
      name: "runner_agent_usage_runner_id_agent_pk",
    }),
  ],
);

export const runnerSkill = pgTable(
  "runner_skill",
  {
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    name: text().notNull(),
    version: text().notNull(),
    sha256: text().notNull(),
    status: text().notNull(),
    reportedAt: bigint("reported_at", { mode: "number" }).notNull(),
    error: text(),
    waiting: bigint({ mode: "number" }),
  },
  (table) => [
    primaryKey({ columns: [table.runnerId, table.name], name: "runner_skill_runner_id_name_pk" }),
    check("runner_skill_check_1", sql`status IN ('installed','pending','refused')`),
  ],
);

export const runAgentSetup = pgTable("run_agent_setup", {
  runId: text("run_id")
    .primaryKey()
    .references(() => run.id),
  runnerId: text("runner_id")
    .notNull()
    .references(() => runner.id),
  skills: text().notNull(),
  hooks: text().notNull(),
  recordedAt: bigint("recorded_at", { mode: "number" }).notNull(),
});

export const runnerRuntime = pgTable(
  "runner_runtime",
  {
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    tool: text().notNull(),
    version: text().notNull(),
    status: text().notNull(),
    error: text(),
    reportedAt: bigint("reported_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runnerId, table.tool, table.version],
      name: "runner_runtime_runner_id_tool_version_pk",
    }),
    check("runner_runtime_check_1", sql`status IN ('installed','failed')`),
  ],
);

export const runnerAgent = pgTable(
  "runner_agent",
  {
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    agent: text().notNull(),
    version: text().notNull(),
    status: text().notNull(),
    error: text(),
    sessions: bigint({ mode: "number" }),
    targetId: text("target_id"),
    reportedAt: bigint("reported_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runnerId, table.agent, table.status],
      name: "runner_agent_runner_id_agent_status_pk",
    }),
    check(
      "runner_agent_check_1",
      sql`status IN ('current','previous','installing','waiting','failed')`,
    ),
  ],
);

export const runnerAgentTarget = pgTable(
  "runner_agent_target",
  {
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    agent: text().notNull(),
    id: text().notNull(),
    version: text().notNull(),
    integrity: text().notNull(),
    nativeVersion: text("native_version"),
    packages: jsonb().notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: bigint("requested_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runnerId, table.agent],
      name: "runner_agent_target_runner_id_agent_pk",
    }),
    check("runner_agent_target_check_1", sql`jsonb_array_length(packages) > 0`),
  ],
);

export const runnerEnrollment = pgTable(
  "runner_enrollment",
  {
    id: text().primaryKey(),
    tokenHash: text("token_hash").notNull(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    name: text().notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    usedAt: bigint("used_at", { mode: "number" }),
    runnerId: text("runner_id").references(() => runner.id),
  },
  (table) => [
    unique().on(table.tokenHash),
    index("runner_enrollment_expiry")
      .on(table.expiresAt)
      .where(sql`used_at IS NULL`),
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
      name: "runner_enrollment_workspace_id_user_id_workspace_member_workspace_id_user_id_fk",
    }),
  ],
);

export const memberVm = pgTable(
  "member_vm",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    vmName: text("vm_name").notNull(),
    step: text().notNull(),
    failure: text(),
    runnerId: text("runner_id").references(() => runner.id),
    stepStartedAt: bigint("step_started_at", { mode: "number" }).notNull(),
    createRequestedAt: bigint("create_requested_at", { mode: "number" }),
    installStartedAt: bigint("install_started_at", { mode: "number" }),
    tokenExpiresAt: bigint("token_expires_at", { mode: "number" }),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    installAt: bigint("install_at", { mode: "number" }),
    enrollAt: bigint("enroll_at", { mode: "number" }),
    healthAt: bigint("health_at", { mode: "number" }),
    readyAt: bigint("ready_at", { mode: "number" }),
    deleteStep: text("delete_step"),
    deleteRunnerId: text("delete_runner_id"),
    deleteRequestedBy: text("delete_requested_by"),
    deleteForce: integer("delete_force").default(0).notNull(),
    deleteStepStartedAt: bigint("delete_step_started_at", { mode: "number" }),
    deleteAt: jsonb("delete_at"),
    deleteFailure: text("delete_failure"),
    deleteBlocked: jsonb("delete_blocked"),
    enrollmentsTracked: integer("enrollments_tracked").default(1).notNull(),
    pool: text(),
  },
  (table) => [
    unique().on(table.vmName),
    unique().on(table.workspaceId, table.userId),
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
      name: "member_vm_workspace_id_user_id_workspace_member_workspace_id_user_id_fk",
    }),
    check("member_vm_check_1", sql`step IN ('create','install','enroll','health','ready')`),
    check(
      "member_vm_check_2",
      sql`delete_step IS NULL OR delete_step IN ('drain','tailnet','revoke','destroy','clear')`,
    ),
    check("member_vm_check_3", sql`delete_force IN (0,1)`),
    check("member_vm_check_6", sql`enrollments_tracked IN (0,1)`),
  ],
);

export const runnerSetupHold = pgTable(
  "runner_setup_hold",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => workItem.id),
    ownerUserId: text("owner_user_id").references(() => workspaceUser.id),
    reason: text().notNull(),
    runnerId: text("runner_id"),
    agent: text(),
    since: bigint({ mode: "number" }).notNull(),
    notifiedAt: bigint("notified_at", { mode: "number" }),
    runId: text("run_id"),
  },
  () => [check("runner_setup_hold_check_1", sql`reason IN ('no-runner','agent-not-signed-in')`)],
);

export const memberVmEnrollment = pgTable(
  "member_vm_enrollment",
  {
    tokenHash: text("token_hash").primaryKey(),
    memberVmId: text("member_vm_id").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [index("member_vm_enrollment_vm").on(table.memberVmId)],
);

export const runnerSetupResume = pgTable("runner_setup_resume", {
  itemId: text("item_id")
    .primaryKey()
    .references(() => workItem.id),
  runId: text("run_id")
    .notNull()
    .references(() => run.id),
  releasedAt: bigint("released_at", { mode: "number" }).notNull(),
});

export const runnerCommand = pgTable(
  "runner_command",
  {
    ordinal: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    id: text().notNull(),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    runId: text("run_id").references(() => run.id),
    generation: bigint({ mode: "number" }),
    kind: text().notNull(),
    envelope: jsonb().notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    acknowledgedAt: bigint("acknowledged_at", { mode: "number" }),
  },
  (table) => [
    unique().on(table.id),
    index("runner_command_pending").on(table.runnerId, table.acknowledgedAt, table.ordinal),
    check(
      "runner_command_check_1",
      sql`kind IN ('run','review','check','task','cancel','handover','checkpoint','probe','login_check','login','upgrade')`,
    ),
  ],
);

export const runnerSessionMove = pgTable(
  "runner_session_move",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => run.id),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    requestedBy: text("requested_by"),
    status: text().notNull(),
    reason: text(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  () => [check("runner_session_move_check_1", sql`status IN ('moving','waiting','stayed')`)],
);

export const policyRunnerWarning = pgTable("policy_runner_warning", {
  repository: text().primaryKey(),
  policyDigest: text("policy_digest").notNull(),
  runnerVersion: text("runner_version").notNull(),
  keys: text().notNull(),
  checkedAt: bigint("checked_at", { mode: "number" }).notNull(),
});

export const runnerLogin = pgTable(
  "runner_login",
  {
    id: text()
      .primaryKey()
      .references(() => runnerCommand.id),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    userId: text("user_id")
      .notNull()
      .references(() => workspaceUser.id),
    agent: text().notNull(),
    state: text().notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    terminal: text().default("").notNull(),
    authorization: text(),
    inputId: text("input_id"),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    bindingId: text("binding_id").references(() => agentAccountBinding.id),
  },
  (table) => [
    index("runner_login_account").on(table.runnerId, table.userId, table.agent, table.updatedAt),
    index("runner_login_binding")
      .on(table.bindingId)
      .where(sql`binding_id IS NOT NULL`),
    check("runner_login_check_1", sql`agent IN ('claude','codex','grok','opencode')`),
    check(
      "runner_login_check_2",
      sql`state IN ('starting','waiting','connected','failed','cancelled','expired')`,
    ),
  ],
);

export const runnerRepositories = pgTable("runner_repositories", {
  runnerId: text("runner_id")
    .primaryKey()
    .references(() => runner.id, { onDelete: "cascade" }),
  repositories: jsonb(),
  reportedAt: bigint("reported_at", { mode: "number" }).notNull(),
  adminRepositories: jsonb("admin_repositories"),
});

export const runnerRepositoryCommand = pgTable(
  "runner_repository_command",
  {
    id: text().primaryKey(),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    payload: text().notNull(),
    state: text().notNull(),
    result: text(),
    grantHash: text("grant_hash"),
    grantExpiresAt: bigint("grant_expires_at", { mode: "number" }),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    deliveredAt: bigint("delivered_at", { mode: "number" }),
    doneAt: bigint("done_at", { mode: "number" }),
  },
  (table) => [
    index("runner_repository_command_runner").on(table.runnerId, table.state),
    check(
      "runner_repository_command_check_1",
      sql`state IN ('pending','delivered','done','expired')`,
    ),
    check("runner_repository_command_check_2", sql`(state = 'done') = (result IS NOT NULL)`),
  ],
);

export const runnerAgentPolicy = pgTable(
  "runner_agent_policy",
  {
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    agent: text().notNull(),
    ready: integer().default(0).notNull(),
    authExpired: integer("auth_expired").default(0).notNull(),
    quotaState: text("quota_state").default("ok").notNull(),
    resetsAt: bigint("resets_at", { mode: "number" }),
    cooldownUntil: bigint("cooldown_until", { mode: "number" }).default(0).notNull(),
    resolvedModel: text("resolved_model"),
    lastUsedAt: bigint("last_used_at", { mode: "number" }).default(0).notNull(),
    virtualFinish: doublePrecision("virtual_finish").default(0).notNull(),
    extraUsage: integer("extra_usage").default(0).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runnerId, table.agent],
      name: "runner_agent_policy_runner_id_agent_pk",
    }),
    check("runner_agent_policy_check_1", sql`agent IN ('claude','codex','grok','opencode')`),
    check("runner_agent_policy_check_2", sql`ready IN (0,1)`),
    check("runner_agent_policy_check_3", sql`auth_expired IN (0,1)`),
    check(
      "runner_agent_policy_check_4",
      sql`quota_state IN ('ok','low','exhausted','spent_extra')`,
    ),
    check("runner_agent_policy_check_5", sql`extra_usage IN (0,1)`),
  ],
);

export const runnerExecutionUsage = pgTable(
  "runner_execution_usage",
  {
    commandId: text("command_id").primaryKey(),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => workspaceUser.id),
    itemId: text("item_id").references(() => workItem.id),
    runId: text("run_id").references(() => run.id),
    agent: text(),
    model: text(),
    role: text().notNull(),
    purpose: text().notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    endedAt: bigint("ended_at", { mode: "number" }),
    outcome: text(),
    resolvedModel: text("resolved_model"),
    outputBytes: bigint("output_bytes", { mode: "number" }).default(0).notNull(),
    resetsAt: bigint("resets_at", { mode: "number" }),
    placementReason: text("placement_reason"),
    accountPolicyRevision: text("account_policy_revision"),
    accountFallback: text("account_fallback"),
  },
  (table) => [
    index("runner_usage_item").on(table.itemId, table.endedAt),
    index("runner_usage_runner_ended").on(table.runnerId, table.endedAt),
    check("runner_execution_usage_check_1", sql`agent IN ('claude','codex','grok','opencode')`),
    check("runner_execution_usage_check_2", sql`role IN ('implementer','reviewer')`),
    check("runner_execution_usage_check_3", sql`purpose IN ('prepare','work','check','helper')`),
    check("runner_execution_usage_check_4", sql`output_bytes>=0`),
    check("runner_execution_usage_check_5", sql`resets_at IS NULL OR resets_at >= 0`),
    check(
      "runner_execution_usage_check_6",
      sql`placement_reason IS NULL OR placement_reason IN ('session_restore','extra_usage')`,
    ),
    check(
      "runner_execution_usage_check_7",
      sql`account_policy_revision IS NULL OR length(account_policy_revision) BETWEEN 1 AND 64`,
    ),
    check(
      "runner_execution_usage_check_8",
      sql`account_fallback IS NULL OR length(account_fallback) BETWEEN 1 AND 500`,
    ),
  ],
);

export const runnerFileObject = pgTable(
  "runner_file_object",
  {
    key: text().primaryKey(),
    runId: text("run_id").notNull(),
    commandId: text("command_id").notNull(),
    kind: text().notNull(),
    name: text().notNull(),
    digest: text().notNull(),
    sha256: text().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("runner_file_object_run").on(table.runId),
    index("runner_file_object_command").on(table.commandId, table.kind),
    check("runner_file_object_check_1", sql`kind IN ('input','artifact')`),
  ],
);
