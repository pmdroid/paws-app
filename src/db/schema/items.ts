import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { question } from "./asks";
import { workspace, workspaceUser } from "./workspace";

export const run = sqliteTable(
  "run",
  {
    id: text().primaryKey().notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    kind: text().notNull(),
    agent: text().notNull(),
    status: text().notNull(),
    checkpoint: text(),
    freshSession: integer("fresh_session").default(0).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    index("run_item").on(table.itemId, table.createdAt),
    check("run_check_1", sql`status IN ('provisioning', 'active', 'ended', 'lost')`),
    check("run_check_2", sql`checkpoint IS NULL OR json_valid(checkpoint)`),
    check("run_check_3", sql`fresh_session IN (0, 1)`),
  ],
);

export const taskRequest = sqliteTable(
  "task_request",
  {
    taskKey: text("task_key").primaryKey().notNull(),
    classification: text().notNull(),
  },
  () => [check("task_request_check_1", sql`json_valid(classification)`)],
);

export const workItemRepository = sqliteTable("work_item_repository", {
  itemId: text("item_id")
    .primaryKey()
    .notNull()
    .references(() => workItem.id),
  owner: text().notNull(),
  repo: text().notNull(),
  remoteUrl: text("remote_url").notNull(),
});

export const workItemRepositoryQuestion = sqliteTable(
  "work_item_repository_question",
  {
    itemId: text("item_id")
      .primaryKey()
      .notNull()
      .references(() => workItem.id),
    questionId: text("question_id")
      .notNull()
      .references(() => question.id),
    candidates: text().notNull(),
    chosenRepository: text("chosen_repository"),
  },
  () => [
    check("work_item_repository_question_check_1", sql`json_valid(candidates)`),
    check(
      "work_item_repository_question_check_2",
      sql`chosen_repository IS NULL OR json_valid(chosen_repository)`,
    ),
  ],
);

export const workItemScheduling = sqliteTable(
  "work_item_scheduling",
  {
    itemId: text("item_id")
      .primaryKey()
      .notNull()
      .references(() => workItem.id),
    projectId: text("project_id"),
    projectKnown: integer("project_known").notNull(),
    priority: integer().default(0).notNull(),
    paths: text(),
    projectLeadId: text("project_lead_id"),
  },
  () => [
    check("work_item_scheduling_check_1", sql`project_known IN (0,1)`),
    check("work_item_scheduling_check_2", sql`priority BETWEEN 0 AND 4`),
    check("work_item_scheduling_check_3", sql`paths IS NULL OR json_valid(paths)`),
  ],
);

export const workItemSpecification = sqliteTable(
  "work_item_specification",
  {
    itemId: text("item_id")
      .primaryKey()
      .notNull()
      .references(() => workItem.id),
    hash: text().notNull(),
    revision: integer().notNull(),
    present: integer().notNull(),
  },
  () => [
    check("work_item_specification_check_1", sql`revision>0`),
    check("work_item_specification_check_2", sql`present IN (0,1)`),
  ],
);

export const taskBlock = sqliteTable(
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

export const itemDependencySnapshot = sqliteTable(
  "item_dependency_snapshot",
  {
    itemId: text("item_id")
      .primaryKey()
      .notNull()
      .references(() => workItem.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    generation: integer().notNull(),
    scope: text().notNull(),
    linearStates: text("linear_states").notNull(),
    externalEvidence: text("external_evidence").default("{}").notNull(),
    linearIdentifiers: text("linear_identifiers").default("[]").notNull(),
  },
  () => [
    check("item_dependency_snapshot_check_1", sql`generation>0`),
    check("item_dependency_snapshot_check_2", sql`json_valid(scope)`),
    check("item_dependency_snapshot_check_3", sql`json_valid(linear_states)`),
    check("item_dependency_snapshot_check_4", sql`json_valid(external_evidence)`),
    check("item_dependency_snapshot_check_5", sql`json_valid(linear_identifiers)`),
  ],
);

export const itemReconciliationRequest = sqliteTable("item_reconciliation_request", {
  itemId: text("item_id")
    .primaryKey()
    .notNull()
    .references(() => workItem.id),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id),
  token: text().notNull(),
});

export const itemReconciliationEffect = sqliteTable(
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

export const usagePause = sqliteTable("usage_pause", {
  runId: text("run_id")
    .primaryKey()
    .notNull()
    .references(() => run.id),
  itemId: text("item_id")
    .notNull()
    .references(() => workItem.id),
  agent: text().notNull(),
  runnerId: text("runner_id"),
  resetsAt: integer("resets_at"),
  resumeAt: integer("resume_at").notNull(),
  pausedAt: integer("paused_at").notNull(),
});

export const queuePosition = sqliteTable(
  "queue_position",
  {
    itemId: text("item_id")
      .primaryKey()
      .notNull()
      .references(() => workItem.id),
    position: integer().notNull(),
    busySlots: integer("busy_slots").notNull(),
    totalSlots: integer("total_slots").notNull(),
    updatedAt: integer("updated_at").notNull(),
    ownerCap: integer("owner_cap"),
  },
  () => [
    check("queue_position_check_1", sql`position >= 1`),
    check("queue_position_check_2", sql`busy_slots >= 0`),
    check("queue_position_check_3", sql`total_slots >= 1`),
    check("queue_position_check_4", sql`owner_cap IS NULL OR owner_cap >= 1`),
  ],
);

export const workItemMergeSettings = sqliteTable(
  "work_item_merge_settings",
  {
    itemId: text("item_id")
      .primaryKey()
      .notNull()
      .references(() => workItem.id),
    mergeOrder: text("merge_order").notNull(),
    mainMoved: text("main_moved").notNull(),
    resolvedJson: text("resolved_json").notNull(),
    resolvedAt: integer("resolved_at").notNull(),
  },
  () => [
    check(
      "work_item_merge_settings_check_1",
      sql`merge_order IN ('queue','ci-green','github-queue')`,
    ),
    check("work_item_merge_settings_check_2", sql`main_moved IN ('overlap','ci','closeout')`),
  ],
);

export const workItemLinearRead = sqliteTable(
  "work_item_linear_read",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    kind: text().notNull(),
    valueJson: text("value_json").notNull(),
    readAt: integer("read_at").notNull(),
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
    check("work_item_linear_read_check_2", sql`json_valid(value_json)`),
  ],
);

export const delegationReconciliation = sqliteTable("delegation_reconciliation", {
  delegationId: text("delegation_id").primaryKey().notNull(),
  changes: integer().default(0).notNull(),
  reconciledChanges: integer("reconciled_changes").default(0).notNull(),
  reconciledAt: integer("reconciled_at"),
});

export const parentDelegation = sqliteTable(
  "parent_delegation",
  {
    delegationId: text("delegation_id").primaryKey().notNull(),
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
    edges: text().notNull(),
    createdAt: integer("created_at").notNull(),
    stoppedAt: integer("stopped_at"),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("parent_delegation_active")
      .on(table.workspaceId, table.parentIssueId)
      .where(sql`stopped_at IS NULL`),
    index("parent_delegation_session").on(table.sessionId),
    check("parent_delegation_check_1", sql`json_valid(edges)`),
  ],
);

export const parentDelegationIssue = sqliteTable(
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
    position: integer().notNull(),
    sessionId: text("session_id"),
    delegationId: text("delegation_id"),
    releasedAt: integer("released_at"),
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

export const workItemEvent = sqliteTable(
  "work_item_event",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    version: integer().notNull(),
    at: integer().notNull(),
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

export const workItem = sqliteTable(
  "work_item",
  {
    id: text().primaryKey().notNull(),
    delegationId: text("delegation_id").notNull(),
    linearIssueId: text("linear_issue_id").notNull(),
    linearIdentifier: text("linear_identifier").notNull(),
    title: text().notNull(),
    state: text().notNull(),
    branchName: text("branch_name").notNull(),
    position: integer().notNull(),
    version: integer().default(0).notNull(),
    taskKey: text("task_key"),
    createdAt: integer("created_at").notNull(),
    checkpoint: text(),
    recoveryAttempts: integer("recovery_attempts").default(0).notNull(),
    awakeMs: integer("awake_ms").default(0).notNull(),
    lastMonoMs: integer("last_mono_ms"),
    turnCount: integer("turn_count").default(0).notNull(),
    maxTurns: integer("max_turns").default(80).notNull(),
    maxAwakeMs: integer("max_awake_ms").default(2700000).notNull(),
    cancelRequested: integer("cancel_requested").default(0).notNull(),
    sessionKey: text("session_key"),
    currentRunId: text("current_run_id"),
    brief: text(),
    ownerUserId: text("owner_user_id").references(() => workspaceUser.id),
    delegatedBy: text("delegated_by"),
    resumedAt: integer("resumed_at"),
    acceptedHead: text("accepted_head"),
    agentMs: integer("agent_ms").default(0).notNull(),
    closeoutMs: integer("closeout_ms").default(0).notNull(),
    waitingMs: integer("waiting_ms").default(0).notNull(),
    recheckMs: integer("recheck_ms").default(0).notNull(),
    linearProjectId: text("linear_project_id"),
    linearProjectName: text("linear_project_name"),
    implementMs: integer("implement_ms").default(0).notNull(),
    fixMs: integer("fix_ms").default(0).notNull(),
    maxFixMs: integer("max_fix_ms").default(0).notNull(),
    maxCloseoutMs: integer("max_closeout_ms").default(0).notNull(),
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
    check("work_item_check_2", sql`checkpoint IS NULL OR json_valid(checkpoint)`),
    check("work_item_check_3", sql`brief IS NULL OR json_valid(brief)`),
  ],
);

export const itemBranchState = sqliteTable(
  "item_branch_state",
  {
    itemId: text("item_id")
      .primaryKey()
      .notNull()
      .references(() => workItem.id),
    runId: text("run_id").notNull(),
    head: text().notNull(),
    base: text().notNull(),
    commits: integer().notNull(),
    recordedAt: integer("recorded_at").notNull(),
  },
  () => [check("item_branch_state_check_1", sql`commits >= 0`)],
);

export const itemCandidate = sqliteTable("item_candidate", {
  itemId: text("item_id")
    .primaryKey()
    .notNull()
    .references(() => workItem.id),
  sha: text().notNull(),
  branch: text().notNull(),
  recordedAt: integer("recorded_at").notNull(),
});

export const itemPullRequest = sqliteTable(
  "item_pull_request",
  {
    itemId: text("item_id")
      .primaryKey()
      .notNull()
      .references(() => workItem.id),
    pullNumber: integer("pull_number").notNull(),
    pullUrl: text("pull_url"),
    openedAt: integer("opened_at").notNull(),
  },
  () => [check("item_pull_request_check_1", sql`pull_number > 0`)],
);

export const itemWait = sqliteTable(
  "item_wait",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    kind: text().notNull(),
    version: integer().notNull(),
    since: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.kind], name: "item_wait_item_id_kind_pk" }),
    check("item_wait_check_1", sql`kind IN ('queue','item')`),
  ],
);

export const workItemTask = sqliteTable(
  "work_item_task",
  {
    itemId: text("item_id")
      .primaryKey()
      .notNull()
      .references(() => workItem.id),
    mode: text().notNull(),
    response: text(),
    generation: integer().default(0).notNull(),
    repositoryContext: integer("repository_context").default(0).notNull(),
  },
  () => [
    check("work_item_task_check_1", sql`mode IN ('code', 'answer', 'artifact', 'plan')`),
    check("work_item_task_check_2", sql`repository_context IN (0,1)`),
  ],
);

export const itemHold = sqliteTable(
  "item_hold",
  {
    itemId: text("item_id")
      .primaryKey()
      .notNull()
      .references(() => workItem.id),
    reason: text().notNull(),
    blockers: text().notNull(),
    files: text().default("[]").notNull(),
  },
  () => [
    check(
      "item_hold_check_1",
      sql`reason IN ('blocked','project','reconciling','snapshot','cap','slot','workspace','overlap')`,
    ),
    check("item_hold_check_2", sql`json_valid(blockers)`),
    check("item_hold_check_3", sql`json_valid(files)`),
  ],
);

export const itemContinuation = sqliteTable(
  "item_continuation",
  {
    itemId: text("item_id")
      .primaryKey()
      .notNull()
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

export const restartHold = sqliteTable("restart_hold", {
  itemId: text("item_id")
    .primaryKey()
    .notNull()
    .references(() => workItem.id, { onDelete: "cascade" }),
  sessionId: text("session_id").notNull(),
  requestedAt: integer("requested_at").notNull(),
});

export const runFallbackAttempt = sqliteTable(
  "run_fallback_attempt",
  {
    runId: text("run_id")
      .notNull()
      .references(() => run.id, { onDelete: "cascade" }),
    callId: text("call_id").notNull(),
    ordinal: integer().notNull(),
    policyKey: text("policy_key").notNull(),
    outcome: text().notNull(),
    runnerId: text("runner_id").notNull(),
    generation: integer().notNull(),
    excludedKey: text("excluded_key").notNull(),
    accountId: text("account_id"),
    bindingId: text("binding_id"),
    recordedAt: integer("recorded_at").notNull(),
    closedAt: integer("closed_at"),
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

export const itemBlockerCheck = sqliteTable("item_blocker_check", {
  itemId: text("item_id")
    .primaryKey()
    .notNull()
    .references(() => workItem.id, { onDelete: "cascade" }),
  checkedAt: integer("checked_at").notNull(),
});
