import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { agentAccountBinding } from "./accounts";
import { run, workItem } from "./items";
import { linearSession } from "./linear";
import { workspace, workspaceMember, workspaceUser } from "./workspace";

export const runner = sqliteTable(
  "runner",
  {
    id: text().primaryKey().notNull(),
    workspaceId: text("workspace_id").notNull(),
    ownerUserId: text("owner_user_id").notNull(),
    name: text().notNull(),
    status: text().notNull(),
    fence: integer().default(0).notNull(),
    createdAt: integer("created_at").notNull(),
    revokedAt: integer("revoked_at"),
    lastSeenAt: integer("last_seen_at"),
    liveReportedAt: integer("live_reported_at"),
    terminationsSince: integer("terminations_since"),
  },
  (table) => [
    foreignKey(() => ({
      columns: [table.workspaceId, table.ownerUserId],
      foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
      name: "runner_workspace_id_owner_user_id_workspace_member_workspace_id_user_id_fk",
    })),
    check("runner_check_1", sql`status IN ('active','paused','draining','revoked')`),
    check("runner_check_2", sql`fence >= 0`),
  ],
);

export const runnerCertificate = sqliteTable(
  "runner_certificate",
  {
    fingerprint: text().primaryKey().notNull(),
    serial: text().notNull(),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    pem: text().notNull(),
    notBefore: integer("not_before").notNull(),
    notAfter: integer("not_after").notNull(),
    acceptedUntil: integer("accepted_until").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [unique().on(table.serial), index("runner_certificate_identity").on(table.runnerId)],
);

export const runnerWork = sqliteTable(
  "runner_work",
  {
    runId: text("run_id")
      .primaryKey()
      .notNull()
      .references(() => run.id),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    generation: integer().notNull(),
    runnerFence: integer("runner_fence").notNull(),
    commandId: text("command_id").notNull(),
    leaseUntil: integer("lease_until").notNull(),
    lastSequence: integer("last_sequence").default(0).notNull(),
    endedAt: integer("ended_at"),
    consumedSequence: integer("consumed_sequence").default(0).notNull(),
    confirmedAt: integer("confirmed_at"),
    lostAt: integer("lost_at"),
    teardownConfirmedAt: integer("teardown_confirmed_at"),
  },
  (table) => [
    unique().on(table.commandId),
    check("runner_work_check_1", sql`generation>0`),
    check("runner_work_check_2", sql`runner_fence>=0`),
    check("runner_work_check_3", sql`last_sequence>=0`),
    check("runner_work_check_4", sql`consumed_sequence>=0`),
  ],
);

export const runnerWorkGrant = sqliteTable("runner_work_grant", {
  tokenHash: text("token_hash").primaryKey().notNull(),
  runId: text("run_id")
    .notNull()
    .references(() => runnerWork.runId),
  generation: integer().notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const runnerEvent = sqliteTable(
  "runner_event",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runnerWork.runId),
    generation: integer().notNull(),
    sequence: integer().notNull(),
    payload: text().notNull(),
    receivedAt: integer("received_at").notNull(),
    keyId: text("key_id"),
    payloadSha256: text("payload_sha256"),
    type: text(),
    handedOver: integer("handed_over"),
    reason: text(),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.generation, table.sequence],
      name: "runner_event_run_id_generation_sequence_pk",
    }),
    index("runner_event_type").on(table.runId, table.generation, table.type),
    check("runner_event_check_1", sql`sequence>0`),
    check("runner_event_check_2", sql`json_valid(payload)`),
  ],
);

export const runnerResult = sqliteTable(
  "runner_result",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runnerWork.runId),
    generation: integer().notNull(),
    commandId: text("command_id")
      .notNull()
      .references(() => runnerCommand.id),
    payload: text().notNull(),
    receivedAt: integer("received_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.generation],
      name: "runner_result_run_id_generation_pk",
    }),
    check("runner_result_check_1", sql`generation>0`),
    check("runner_result_check_2", sql`json_valid(payload)`),
  ],
);

export const runnerQuestionAnswer = sqliteTable(
  "runner_question_answer",
  {
    runId: text("run_id").notNull(),
    generation: integer().notNull(),
    sequence: integer().notNull(),
    answer: text().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    foreignKey(() => ({
      columns: [table.runId, table.generation, table.sequence],
      foreignColumns: [runnerEvent.runId, runnerEvent.generation, runnerEvent.sequence],
      name: "runner_question_answer_run_id_generation_sequence_runner_event_run_id_generation_sequence_fk",
    })),
    primaryKey({
      columns: [table.runId, table.generation, table.sequence],
      name: "runner_question_answer_run_id_generation_sequence_pk",
    }),
  ],
);

export const runnerHealthResult = sqliteTable("runner_health_result", {
  commandId: text("command_id")
    .primaryKey()
    .notNull()
    .references(() => runnerCommand.id),
  runnerId: text("runner_id")
    .notNull()
    .references(() => runner.id),
  resultJson: text("result_json").notNull(),
  receivedAt: integer("received_at").notNull(),
});

export const runnerTranscript = sqliteTable(
  "runner_transcript",
  {
    runId: text("run_id")
      .notNull()
      .references(() => run.id),
    generation: integer().notNull(),
    commandId: text("command_id")
      .notNull()
      .references(() => runnerCommand.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    executionId: text("execution_id").notNull(),
    sizeBytes: integer("size_bytes").default(0).notNull(),
    sealedSize: integer("sealed_size"),
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

export const runnerTranscriptChunk = sqliteTable(
  "runner_transcript_chunk",
  {
    runId: text("run_id").notNull(),
    generation: integer().notNull(),
    offset: integer().notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text().notNull(),
    keyId: text("key_id"),
  },
  (table) => [
    foreignKey(() => ({
      columns: [table.runId, table.generation],
      foreignColumns: [runnerTranscript.runId, runnerTranscript.generation],
      name: "runner_transcript_chunk_run_id_generation_runner_transcript_run_id_generation_fk",
    })),
    primaryKey({
      columns: [table.runId, table.generation, table.offset],
      name: "runner_transcript_chunk_run_id_generation_offset_pk",
    }),
    check("runner_transcript_chunk_check_1", sql`offset>=0`),
    check("runner_transcript_chunk_check_2", sql`size_bytes BETWEEN 1 AND 524288`),
    check("runner_transcript_chunk_check_3", sql`length(sha256)=64`),
    check("runner_transcript_chunk_check_4", sql`key_id IS NULL OR length(key_id)=64`),
  ],
);

export const runnerHelper = sqliteTable(
  "runner_helper",
  {
    id: text().primaryKey().notNull(),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    sessionId: text("session_id")
      .notNull()
      .references(() => linearSession.sessionId),
    sessionGeneration: integer("session_generation").notNull(),
    runnerFence: integer("runner_fence").notNull(),
    envelope: text().notNull(),
    expiresAt: integer("expires_at").notNull(),
    acknowledgedAt: integer("acknowledged_at"),
    endedAt: integer("ended_at"),
    result: text(),
  },
  (table) => [
    index("runner_helper_pending").on(table.runnerId, table.acknowledgedAt, table.expiresAt),
    check("runner_helper_check_1", sql`json_valid(envelope)`),
    check("runner_helper_check_2", sql`result IS NULL OR json_valid(result)`),
  ],
);

export const runnerPolicy = sqliteTable(
  "runner_policy",
  {
    runnerId: text("runner_id")
      .primaryKey()
      .notNull()
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

export const runnerCapacity = sqliteTable(
  "runner_capacity",
  {
    runnerId: text("runner_id")
      .primaryKey()
      .notNull()
      .references(() => runner.id),
    capacity: integer().notNull(),
    ceiling: integer(),
    desired: integer(),
  },
  () => [
    check("runner_capacity_check_1", sql`capacity BETWEEN 1 AND 16`),
    check("runner_capacity_check_2", sql`ceiling IS NULL OR ceiling BETWEEN 1 AND 16`),
    check("runner_capacity_check_3", sql`desired IS NULL OR desired BETWEEN 1 AND 16`),
  ],
);

export const runnerHostStatus = sqliteTable(
  "runner_host_status",
  {
    runnerId: text("runner_id")
      .primaryKey()
      .notNull()
      .references(() => runner.id),
    cpuPercent: real("cpu_percent"),
    memoryTotalBytes: integer("memory_total_bytes"),
    memoryAvailableBytes: integer("memory_available_bytes"),
    load1: real("load_1"),
    load5: real("load_5"),
    load15: real("load_15"),
    diskTotalBytes: integer("disk_total_bytes"),
    diskFreeBytes: integer("disk_free_bytes"),
    osId: text("os_id"),
    osVersion: text("os_version"),
    runnerVersion: text("runner_version"),
    reportedAt: integer("reported_at").notNull(),
    cpuCount: integer("cpu_count"),
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

export const runnerFollowUp = sqliteTable(
  "runner_follow_up",
  {
    runId: text("run_id").notNull(),
    generation: integer().notNull(),
    sequence: integer().notNull(),
    body: text().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.generation, table.sequence],
      name: "runner_follow_up_run_id_generation_sequence_pk",
    }),
    check("runner_follow_up_check_1", sql`sequence>0`),
  ],
);

export const runnerAgentUsage = sqliteTable(
  "runner_agent_usage",
  {
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id, { onDelete: "cascade" }),
    agent: text().notNull(),
    limitsJson: text("limits_json").notNull(),
    observedAt: integer("observed_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runnerId, table.agent],
      name: "runner_agent_usage_runner_id_agent_pk",
    }),
  ],
);

export const runnerSkill = sqliteTable(
  "runner_skill",
  {
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    name: text().notNull(),
    version: text().notNull(),
    sha256: text().notNull(),
    status: text().notNull(),
    reportedAt: integer("reported_at").notNull(),
    error: text(),
    waiting: integer(),
  },
  (table) => [
    primaryKey({ columns: [table.runnerId, table.name], name: "runner_skill_runner_id_name_pk" }),
    check("runner_skill_check_1", sql`status IN ('installed','pending','refused')`),
  ],
);

export const runAgentSetup = sqliteTable("run_agent_setup", {
  runId: text("run_id")
    .primaryKey()
    .notNull()
    .references(() => run.id),
  runnerId: text("runner_id")
    .notNull()
    .references(() => runner.id),
  skills: text().notNull(),
  hooks: text().notNull(),
  recordedAt: integer("recorded_at").notNull(),
});

export const runnerRuntime = sqliteTable(
  "runner_runtime",
  {
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    tool: text().notNull(),
    version: text().notNull(),
    status: text().notNull(),
    error: text(),
    reportedAt: integer("reported_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runnerId, table.tool, table.version],
      name: "runner_runtime_runner_id_tool_version_pk",
    }),
    check("runner_runtime_check_1", sql`status IN ('installed','failed')`),
  ],
);

export const runnerAgent = sqliteTable(
  "runner_agent",
  {
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    agent: text().notNull(),
    version: text().notNull(),
    status: text().notNull(),
    error: text(),
    sessions: integer(),
    targetId: text("target_id"),
    reportedAt: integer("reported_at").notNull(),
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

export const runnerAgentTarget = sqliteTable(
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
    packages: text().notNull(),
    requestedBy: text("requested_by").notNull(),
    requestedAt: integer("requested_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.runnerId, table.agent],
      name: "runner_agent_target_runner_id_agent_pk",
    }),
    check(
      "runner_agent_target_check_1",
      sql`json_valid(packages) AND json_array_length(packages) > 0`,
    ),
  ],
);

export const runnerEnrollment = sqliteTable(
  "runner_enrollment",
  {
    id: text().primaryKey().notNull(),
    tokenHash: text("token_hash").notNull(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    name: text().notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
    runnerId: text("runner_id").references(() => runner.id),
  },
  (table) => [
    foreignKey(() => ({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
      name: "runner_enrollment_workspace_id_user_id_workspace_member_workspace_id_user_id_fk",
    })),
    unique().on(table.tokenHash),
    index("runner_enrollment_expiry")
      .on(table.expiresAt)
      .where(sql`used_at IS NULL`),
  ],
);

export const memberVm = sqliteTable(
  "member_vm",
  {
    id: text().primaryKey().notNull(),
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    vmName: text("vm_name").notNull(),
    step: text().notNull(),
    failure: text(),
    runnerId: text("runner_id").references(() => runner.id),
    stepStartedAt: integer("step_started_at").notNull(),
    createRequestedAt: integer("create_requested_at"),
    installStartedAt: integer("install_started_at"),
    tokenExpiresAt: integer("token_expires_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    installAt: integer("install_at"),
    enrollAt: integer("enroll_at"),
    healthAt: integer("health_at"),
    readyAt: integer("ready_at"),
    deleteStep: text("delete_step"),
    deleteRunnerId: text("delete_runner_id"),
    deleteRequestedBy: text("delete_requested_by"),
    deleteForce: integer("delete_force").default(0).notNull(),
    deleteStepStartedAt: integer("delete_step_started_at"),
    deleteAt: text("delete_at"),
    deleteFailure: text("delete_failure"),
    deleteBlocked: text("delete_blocked"),
    enrollmentsTracked: integer("enrollments_tracked").default(1).notNull(),
    pool: text(),
  },
  (table) => [
    foreignKey(() => ({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
      name: "member_vm_workspace_id_user_id_workspace_member_workspace_id_user_id_fk",
    })),
    unique().on(table.vmName),
    unique().on(table.workspaceId, table.userId),
    check("member_vm_check_1", sql`step IN ('create','install','enroll','health','ready')`),
    check(
      "member_vm_check_2",
      sql`delete_step IS NULL OR delete_step IN ('drain','tailnet','revoke','destroy','clear')`,
    ),
    check("member_vm_check_3", sql`delete_force IN (0,1)`),
    check("member_vm_check_4", sql`delete_at IS NULL OR json_valid(delete_at)`),
    check("member_vm_check_5", sql`delete_blocked IS NULL OR json_valid(delete_blocked)`),
    check("member_vm_check_6", sql`enrollments_tracked IN (0,1)`),
  ],
);

export const runnerSetupHold = sqliteTable(
  "runner_setup_hold",
  {
    itemId: text("item_id")
      .primaryKey()
      .notNull()
      .references(() => workItem.id),
    ownerUserId: text("owner_user_id").references(() => workspaceUser.id),
    reason: text().notNull(),
    runnerId: text("runner_id"),
    agent: text(),
    since: integer().notNull(),
    notifiedAt: integer("notified_at"),
    runId: text("run_id"),
  },
  () => [check("runner_setup_hold_check_1", sql`reason IN ('no-runner','agent-not-signed-in')`)],
);

export const memberVmEnrollment = sqliteTable(
  "member_vm_enrollment",
  {
    tokenHash: text("token_hash").primaryKey().notNull(),
    memberVmId: text("member_vm_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("member_vm_enrollment_vm").on(table.memberVmId)],
);

export const runnerSetupResume = sqliteTable("runner_setup_resume", {
  itemId: text("item_id")
    .primaryKey()
    .notNull()
    .references(() => workItem.id),
  runId: text("run_id")
    .notNull()
    .references(() => run.id),
  releasedAt: integer("released_at").notNull(),
});

export const runnerCommand = sqliteTable(
  "runner_command",
  {
    ordinal: integer().primaryKey({ autoIncrement: true }),
    id: text().notNull(),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    runId: text("run_id").references(() => run.id),
    generation: integer(),
    kind: text().notNull(),
    envelope: text().notNull(),
    expiresAt: integer("expires_at").notNull(),
    acknowledgedAt: integer("acknowledged_at"),
  },
  (table) => [
    unique().on(table.id),
    index("runner_command_pending").on(table.runnerId, table.acknowledgedAt, table.ordinal),
    check(
      "runner_command_check_1",
      sql`kind IN ('run','review','check','task','cancel','handover','checkpoint','probe','login_check','login','upgrade')`,
    ),
    check("runner_command_check_2", sql`json_valid(envelope)`),
  ],
);

export const runnerSessionMove = sqliteTable(
  "runner_session_move",
  {
    runId: text("run_id")
      .primaryKey()
      .notNull()
      .references(() => run.id),
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    requestedBy: text("requested_by"),
    status: text().notNull(),
    reason: text(),
    updatedAt: integer("updated_at").notNull(),
  },
  () => [check("runner_session_move_check_1", sql`status IN ('moving','waiting','stayed')`)],
);

export const policyRunnerWarning = sqliteTable("policy_runner_warning", {
  repository: text().primaryKey().notNull(),
  policyDigest: text("policy_digest").notNull(),
  runnerVersion: text("runner_version").notNull(),
  keys: text().notNull(),
  checkedAt: integer("checked_at").notNull(),
});

export const runnerLogin = sqliteTable(
  "runner_login",
  {
    id: text()
      .primaryKey()
      .notNull()
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
    expiresAt: integer("expires_at").notNull(),
    terminal: text().default("").notNull(),
    authorization: text(),
    inputId: text("input_id"),
    updatedAt: integer("updated_at").notNull(),
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

export const runnerRepositories = sqliteTable(
  "runner_repositories",
  {
    runnerId: text("runner_id")
      .primaryKey()
      .notNull()
      .references(() => runner.id, { onDelete: "cascade" }),
    repositories: text(),
    reportedAt: integer("reported_at").notNull(),
    adminRepositories: text("admin_repositories"),
  },
  () => [
    check("runner_repositories_check_1", sql`repositories IS NULL OR json_valid(repositories)`),
    check(
      "runner_repositories_check_2",
      sql`admin_repositories IS NULL OR json_valid(admin_repositories)`,
    ),
  ],
);

export const runnerRepositoryCommand = sqliteTable(
  "runner_repository_command",
  {
    id: text().primaryKey().notNull(),
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
    grantExpiresAt: integer("grant_expires_at"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
    deliveredAt: integer("delivered_at"),
    doneAt: integer("done_at"),
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

export const runnerAgentPolicy = sqliteTable(
  "runner_agent_policy",
  {
    runnerId: text("runner_id")
      .notNull()
      .references(() => runner.id),
    agent: text().notNull(),
    ready: integer().default(0).notNull(),
    authExpired: integer("auth_expired").default(0).notNull(),
    quotaState: text("quota_state").default("ok").notNull(),
    resetsAt: integer("resets_at"),
    cooldownUntil: integer("cooldown_until").default(0).notNull(),
    resolvedModel: text("resolved_model"),
    lastUsedAt: integer("last_used_at").default(0).notNull(),
    virtualFinish: real("virtual_finish").default(0).notNull(),
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

export const runnerExecutionUsage = sqliteTable(
  "runner_execution_usage",
  {
    commandId: text("command_id").primaryKey().notNull(),
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
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    outcome: text(),
    resolvedModel: text("resolved_model"),
    outputBytes: integer("output_bytes").default(0).notNull(),
    resetsAt: integer("resets_at"),
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

export const runnerFileObject = sqliteTable(
  "runner_file_object",
  {
    key: text().primaryKey().notNull(),
    runId: text("run_id").notNull(),
    commandId: text("command_id").notNull(),
    kind: text().notNull(),
    name: text().notNull(),
    digest: text().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("runner_file_object_run").on(table.runId),
    index("runner_file_object_command").on(table.commandId, table.kind),
    check("runner_file_object_check_1", sql`kind IN ('input','artifact')`),
  ],
);
