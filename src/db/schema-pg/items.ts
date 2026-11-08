import {
  bigint,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { question } from "./asks";
import { workspace, workspaceUser } from "./workspace";

export const run = pgTable(
  "run",
  {
    id: text().primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    kind: text().notNull(),
    agent: text().notNull(),
    status: text().notNull(),
    checkpoint: jsonb(),
    freshSession: integer("fresh_session").default(0).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("run_item").on(table.itemId, table.createdAt),
    check("run_check_1", sql`status IN ('provisioning', 'active', 'ended', 'lost')`),
    check("run_check_3", sql`fresh_session IN (0, 1)`),
  ],
);

export const taskRequest = pgTable("task_request", {
  taskKey: text("task_key").primaryKey(),
  classification: jsonb().notNull(),
});

export const workItemRepository = pgTable("work_item_repository", {
  itemId: text("item_id")
    .primaryKey()
    .references(() => workItem.id),
  owner: text().notNull(),
  repo: text().notNull(),
  remoteUrl: text("remote_url").notNull(),
});

export const workItemRepositoryQuestion = pgTable("work_item_repository_question", {
  itemId: text("item_id")
    .primaryKey()
    .references(() => workItem.id),
  questionId: text("question_id")
    .notNull()
    .references(() => question.id),
  candidates: jsonb().notNull(),
  chosenRepository: jsonb("chosen_repository"),
});

export const workItemScheduling = pgTable(
  "work_item_scheduling",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => workItem.id),
    projectId: text("project_id"),
    projectKnown: integer("project_known").notNull(),
    priority: bigint({ mode: "number" }).default(0).notNull(),
    paths: jsonb(),
    projectLeadId: text("project_lead_id"),
  },
  () => [
    check("work_item_scheduling_check_1", sql`project_known IN (0,1)`),
    check("work_item_scheduling_check_2", sql`priority BETWEEN 0 AND 4`),
  ],
);

export const workItemSpecification = pgTable(
  "work_item_specification",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => workItem.id),
    hash: text().notNull(),
    revision: bigint({ mode: "number" }).notNull(),
    present: integer().notNull(),
  },
  () => [
    check("work_item_specification_check_1", sql`revision>0`),
    check("work_item_specification_check_2", sql`present IN (0,1)`),
  ],
);

export const taskBlock = pgTable(
  "task_block",
  {
    blockerLinearIssueId: text("blocker_linear_issue_id").notNull(),
    blockedLinearIssueId: text("blocked_linear_issue_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.blockedLinearIssueId, table.blockerLinearIssueId],
      name: "task_block_blocked_linear_issue_id_blocker_linear_issue_id_pk",
    }),
    index("task_block_blocker").on(table.blockerLinearIssueId),
    check("task_block_check_1", sql`blocker_linear_issue_id <> blocked_linear_issue_id`),
  ],
);

export const itemDependencySnapshot = pgTable(
  "item_dependency_snapshot",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => workItem.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    generation: bigint({ mode: "number" }).notNull(),
    scope: jsonb().notNull(),
    linearStates: jsonb("linear_states").notNull(),
    externalEvidence: jsonb("external_evidence").default({}).notNull(),
    linearIdentifiers: jsonb("linear_identifiers").default([]).notNull(),
  },
  () => [check("item_dependency_snapshot_check_1", sql`generation>0`)],
);

export const itemReconciliationRequest = pgTable("item_reconciliation_request", {
  itemId: text("item_id")
    .primaryKey()
    .references(() => workItem.id),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id),
  token: text().notNull(),
});

export const itemReconciliationEffect = pgTable(
  "item_reconciliation_effect",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    kind: text().notNull(),
    token: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.itemId, table.kind],
      name: "item_reconciliation_effect_item_id_kind_pk",
    }),
    check("item_reconciliation_effect_check_1", sql`kind IN ('spec','removed','canceled')`),
  ],
);

export const usagePause = pgTable("usage_pause", {
  runId: text("run_id")
    .primaryKey()
    .references(() => run.id),
  itemId: text("item_id")
    .notNull()
    .references(() => workItem.id),
  agent: text().notNull(),
  runnerId: text("runner_id"),
  resetsAt: bigint("resets_at", { mode: "number" }),
  resumeAt: bigint("resume_at", { mode: "number" }).notNull(),
  pausedAt: bigint("paused_at", { mode: "number" }).notNull(),
});

export const queuePosition = pgTable(
  "queue_position",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => workItem.id),
    position: bigint({ mode: "number" }).notNull(),
    busySlots: bigint("busy_slots", { mode: "number" }).notNull(),
    totalSlots: bigint("total_slots", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    ownerCap: bigint("owner_cap", { mode: "number" }),
  },
  () => [
    check("queue_position_check_1", sql`position >= 1`),
    check("queue_position_check_2", sql`busy_slots >= 0`),
    check("queue_position_check_3", sql`total_slots >= 1`),
    check("queue_position_check_4", sql`owner_cap IS NULL OR owner_cap >= 1`),
  ],
);

export const workItemMergeSettings = pgTable(
  "work_item_merge_settings",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => workItem.id),
    mergeOrder: text("merge_order").notNull(),
    mainMoved: text("main_moved").notNull(),
    resolvedJson: text("resolved_json").notNull(),
    resolvedAt: bigint("resolved_at", { mode: "number" }).notNull(),
  },
  () => [
    check(
      "work_item_merge_settings_check_1",
      sql`merge_order IN ('queue','ci-green','github-queue')`,
    ),
    check("work_item_merge_settings_check_2", sql`main_moved IN ('overlap','ci','closeout')`),
  ],
);

export const workItemLinearRead = pgTable(
  "work_item_linear_read",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    kind: text().notNull(),
    valueJson: jsonb("value_json").notNull(),
    readAt: bigint("read_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.itemId, table.kind],
      name: "work_item_linear_read_item_id_kind_pk",
    }),
    check(
      "work_item_linear_read_check_1",
      sql`kind IN ('project_overview','repository_hints','repository_suggestions')`,
    ),
  ],
);

export const delegationReconciliation = pgTable("delegation_reconciliation", {
  delegationId: text("delegation_id").primaryKey(),
  changes: bigint({ mode: "number" }).default(0).notNull(),
  reconciledChanges: bigint("reconciled_changes", { mode: "number" }).default(0).notNull(),
  reconciledAt: bigint("reconciled_at", { mode: "number" }),
});

export const parentDelegation = pgTable(
  "parent_delegation",
  {
    delegationId: text("delegation_id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    organizationId: text("organization_id").notNull(),
    parentIssueId: text("parent_issue_id").notNull(),
    parentIdentifier: text("parent_identifier").notNull(),
    title: text().notNull(),
    sessionId: text("session_id").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => workspaceUser.id),
    edges: jsonb().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    stoppedAt: bigint("stopped_at", { mode: "number" }),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("parent_delegation_active")
      .on(table.workspaceId, table.parentIssueId)
      .where(sql`stopped_at IS NULL`),
    index("parent_delegation_session").on(table.sessionId),
  ],
);

export const parentDelegationIssue = pgTable(
  "parent_delegation_issue",
  {
    parentDelegationId: text("parent_delegation_id")
      .notNull()
      .references(() => parentDelegation.delegationId),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    issueId: text("issue_id").notNull(),
    identifier: text().notNull(),
    title: text().notNull(),
    url: text(),
    position: bigint({ mode: "number" }).notNull(),
    sessionId: text("session_id"),
    delegationId: text("delegation_id"),
    releasedAt: bigint("released_at", { mode: "number" }),
  },
  (table) => [
    primaryKey({
      columns: [table.parentDelegationId, table.issueId],
      name: "parent_delegation_issue_parent_delegation_id_issue_id_pk",
    }),
    unique().on(table.sessionId),
    uniqueIndex("parent_delegation_issue_active")
      .on(table.workspaceId, table.issueId)
      .where(sql`released_at IS NULL`),
    index("parent_delegation_issue_delegation").on(table.delegationId),
  ],
);

export const workItemEvent = pgTable(
  "work_item_event",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    version: bigint({ mode: "number" }).notNull(),
    at: bigint({ mode: "number" }).notNull(),
    fromState: text("from_state").notNull(),
    toState: text("to_state").notNull(),
    event: text().notNull(),
    kind: text().default("transition").notNull(),
    reason: text(),
    payloadDigest: text("payload_digest"),
    actor: text(),
  },
  (table) => [
    unique().on(table.itemId, table.version),
    check("work_item_event_check_1", sql`kind IN ('transition','restart','ask')`),
    check(
      "work_item_event_check_2",
      sql`kind<>'restart' OR reason IN ('findings','ci','review','conflict','follow_up','answer')`,
    ),
    check("work_item_event_check_3", sql`kind<>'ask' OR reason IS NOT NULL`),
  ],
);

export const workItem = pgTable(
  "work_item",
  {
    id: text().primaryKey(),
    delegationId: text("delegation_id").notNull(),
    linearIssueId: text("linear_issue_id").notNull(),
    linearIdentifier: text("linear_identifier").notNull(),
    title: text().notNull(),
    state: text().notNull(),
    branchName: text("branch_name").notNull(),
    position: bigint({ mode: "number" }).notNull(),
    version: bigint({ mode: "number" }).default(0).notNull(),
    taskKey: text("task_key"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    checkpoint: jsonb(),
    recoveryAttempts: bigint("recovery_attempts", { mode: "number" }).default(0).notNull(),
    awakeMs: bigint("awake_ms", { mode: "number" }).default(0).notNull(),
    lastMonoMs: bigint("last_mono_ms", { mode: "number" }),
    turnCount: bigint("turn_count", { mode: "number" }).default(0).notNull(),
    maxTurns: bigint("max_turns", { mode: "number" }).default(80).notNull(),
    maxAwakeMs: bigint("max_awake_ms", { mode: "number" }).default(2700000).notNull(),
    cancelRequested: bigint("cancel_requested", { mode: "number" }).default(0).notNull(),
    sessionKey: text("session_key"),
    currentRunId: text("current_run_id"),
    brief: jsonb(),
    ownerUserId: text("owner_user_id").references(() => workspaceUser.id),
    delegatedBy: text("delegated_by"),
    resumedAt: bigint("resumed_at", { mode: "number" }),
    acceptedHead: text("accepted_head"),
    agentMs: bigint("agent_ms", { mode: "number" }).default(0).notNull(),
    closeoutMs: bigint("closeout_ms", { mode: "number" }).default(0).notNull(),
    waitingMs: bigint("waiting_ms", { mode: "number" }).default(0).notNull(),
    recheckMs: bigint("recheck_ms", { mode: "number" }).default(0).notNull(),
    linearProjectId: text("linear_project_id"),
    linearProjectName: text("linear_project_name"),
    implementMs: bigint("implement_ms", { mode: "number" }).default(0).notNull(),
    fixMs: bigint("fix_ms", { mode: "number" }).default(0).notNull(),
    maxFixMs: bigint("max_fix_ms", { mode: "number" }).default(0).notNull(),
    maxCloseoutMs: bigint("max_closeout_ms", { mode: "number" }).default(0).notNull(),
  },
  (table) => [
    unique().on(table.taskKey),
    uniqueIndex("work_item_active_issue")
      .on(table.linearIssueId)
      .where(sql`state NOT IN ('completed','merged','cancelled')`),
    index("work_item_delegation_position").on(table.delegationId, table.position),
    check(
      "work_item_check_1",
      sql`state IN ( 'planning', 'queued', 'running', 'paused', 'awaiting_input', 'recovering', 'verifying', 'failed', 'merge_queue', 'manual', 'completed', 'merged', 'cancelled' )`,
    ),
  ],
);

export const itemBranchState = pgTable(
  "item_branch_state",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => workItem.id),
    runId: text("run_id").notNull(),
    head: text().notNull(),
    base: text().notNull(),
    commits: bigint({ mode: "number" }).notNull(),
    recordedAt: bigint("recorded_at", { mode: "number" }).notNull(),
  },
  () => [check("item_branch_state_check_1", sql`commits >= 0`)],
);

export const itemCandidate = pgTable("item_candidate", {
  itemId: text("item_id")
    .primaryKey()
    .references(() => workItem.id),
  sha: text().notNull(),
  branch: text().notNull(),
  recordedAt: bigint("recorded_at", { mode: "number" }).notNull(),
});

export const itemPullRequest = pgTable(
  "item_pull_request",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => workItem.id),
    pullNumber: bigint("pull_number", { mode: "number" }).notNull(),
    pullUrl: text("pull_url"),
    openedAt: bigint("opened_at", { mode: "number" }).notNull(),
  },
  () => [check("item_pull_request_check_1", sql`pull_number > 0`)],
);

export const itemWait = pgTable(
  "item_wait",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    kind: text().notNull(),
    version: bigint({ mode: "number" }).notNull(),
    since: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.kind], name: "item_wait_item_id_kind_pk" }),
    check("item_wait_check_1", sql`kind IN ('queue','item')`),
  ],
);

export const workItemTask = pgTable(
  "work_item_task",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => workItem.id),
    mode: text().notNull(),
    response: text(),
    generation: bigint({ mode: "number" }).default(0).notNull(),
    repositoryContext: integer("repository_context").default(0).notNull(),
  },
  () => [
    check("work_item_task_check_1", sql`mode IN ('code', 'answer', 'artifact', 'plan')`),
    check("work_item_task_check_2", sql`repository_context IN (0,1)`),
  ],
);

export const itemHold = pgTable(
  "item_hold",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => workItem.id),
    reason: text(),
    blockers: jsonb().notNull(),
    files: jsonb().default([]).notNull(),
    overlapSince: bigint("overlap_since", { mode: "number" }),
  },
  () => [
    check(
      "item_hold_check_1",
      sql`reason IN ('blocked','project','reconciling','snapshot','cap','slot','workspace','overlap')`,
    ),
  ],
);

export const itemContinuation = pgTable(
  "item_continuation",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => workItem.id),
    previousItemId: text("previous_item_id")
      .notNull()
      .references(() => workItem.id),
    branch: text().notNull(),
  },
  (table) => [
    index("item_continuation_previous").on(table.previousItemId),
    check("item_continuation_check_1", sql`branch LIKE 'paws/%'`),
  ],
);

export const restartHold = pgTable("restart_hold", {
  itemId: text("item_id")
    .primaryKey()
    .references(() => workItem.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  requestedAt: bigint("requested_at", { mode: "number" }).notNull(),
});

export const runFallbackAttempt = pgTable(
  "run_fallback_attempt",
  {
    runId: text("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    ordinal: bigint({ mode: "number" }).notNull(),
    policyKey: text("policy_key").notNull(),
    outcome: text().notNull(),
    runnerId: text("runner_id").notNull(),
    generation: bigint({ mode: "number" }).notNull(),
    excludedKey: text("excluded_key").notNull(),
    accountId: text("account_id"),
    bindingId: text("binding_id"),
    recordedAt: bigint("recorded_at", { mode: "number" }).notNull(),
    closedAt: bigint("closed_at", { mode: "number" }),
  },
  (table) => [
    primaryKey({
      columns: [table.runId, table.callId, table.ordinal],
      name: "run_fallback_attempt_run_id_call_id_ordinal_pk",
    }),
    uniqueIndex("run_fallback_attempt_open")
      .on(
        table.runId,
        table.callId,
        table.runnerId,
        table.generation,
        table.excludedKey,
        table.outcome,
      )
      .where(sql`closed_at IS NULL`),
    check("run_fallback_attempt_check_1", sql`length(call_id) BETWEEN 1 AND 300`),
    check("run_fallback_attempt_check_2", sql`ordinal BETWEEN 1 AND 256`),
    check("run_fallback_attempt_check_3", sql`length(policy_key) BETWEEN 1 AND 2000`),
    check("run_fallback_attempt_check_4", sql`outcome IN ('failed','handed_over','usage_limit')`),
    check("run_fallback_attempt_check_5", sql`generation>=0`),
    check("run_fallback_attempt_check_6", sql`length(excluded_key)<=300`),
  ],
);

export const itemBlockerCheck = pgTable("item_blocker_check", {
  itemId: text("item_id")
    .primaryKey()
    .references(() => workItem.id, { onDelete: "cascade" }),
  checkedAt: bigint("checked_at", { mode: "number" }).notNull(),
});
