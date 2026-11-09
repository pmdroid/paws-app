import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { question } from "./asks";
import { run, workItem } from "./items";
import { job } from "./jobs";
import { workspace } from "./workspace";

export const closeoutProgress = sqliteTable(
  "closeout_progress",
  {
    id: text().primaryKey().notNull(),
    itemId: text("item_id").notNull(),
    taskId: text("task_id").notNull(),
    base: text().notNull(),
    head: text().notNull(),
    policyDigest: text("policy_digest").notNull(),
    policyPath: text("policy_path"),
    decision: text(),
    startedAt: integer("started_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    finishedAt: integer("finished_at"),
    recheckDigest: text("recheck_digest"),
  },
  (table) => [index("closeout_progress_item").on(table.itemId, table.updatedAt)],
);

export const closeoutStep = sqliteTable(
  "closeout_step",
  {
    progressId: text("progress_id")
      .notNull()
      .references(() => closeoutProgress.id),
    stepId: text("step_id").notNull(),
    kind: text().notNull(),
    state: text().notNull(),
    command: text().notNull(),
    detail: text(),
    attempt: integer().notNull(),
    timeoutSeconds: integer("timeout_seconds"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    exitCode: integer("exit_code"),
    timedOut: integer("timed_out").default(0).notNull(),
    timeoutReason: text("timeout_reason"),
    stdout: text().default("").notNull(),
    stderr: text().default("").notNull(),
    truncated: integer().default(0).notNull(),
    logPath: text("log_path"),
    evidencePath: text("evidence_path"),
    findings: text(),
    ordinal: integer().notNull(),
    durationMs: integer("duration_ms"),
    tokens: integer(),
    reviewFailOn: text("review_fail_on"),
    reviewPreExisting: text("review_pre_existing"),
  },
  (table) => [
    primaryKey({
      columns: [table.progressId, table.stepId],
      name: "closeout_step_progress_id_step_id_pk",
    }),
    check("closeout_step_check_1", sql`kind IN ('setup', 'command', 'review')`),
    check(
      "closeout_step_check_2",
      sql`state IN ( 'pending', 'running', 'passed', 'failed', 'blocked', 'skipped', 'exhausted' )`,
    ),
    check("closeout_step_check_3", sql`timed_out IN (0, 1)`),
    check("closeout_step_check_4", sql`truncated IN (0, 1)`),
    check("closeout_step_check_5", sql`duration_ms IS NULL OR duration_ms >= 0`),
    check("closeout_step_check_6", sql`tokens IS NULL OR tokens >= 0`),
    check(
      "closeout_step_check_7",
      sql`review_fail_on IS NULL OR review_fail_on IN ('P0', 'P1', 'P2', 'P3')`,
    ),
  ],
);

export const closeoutRecovery = sqliteTable(
  "closeout_recovery",
  {
    questionId: text("question_id")
      .primaryKey()
      .notNull()
      .references(() => question.id),
    taskId: text("task_id").notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    base: text().notNull(),
    head: text().notNull(),
    policyDigest: text("policy_digest").notNull(),
    failedChecks: text("failed_checks").notNull(),
    retryBaseline: text("retry_baseline").notNull(),
    summary: text().notNull(),
  },
  (table) => [
    index("closeout_recovery_item").on(table.itemId),
    check("closeout_recovery_check_1", sql`json_valid(failed_checks)`),
    check("closeout_recovery_check_2", sql`json_valid(retry_baseline)`),
  ],
);

export const evidence = sqliteTable(
  "evidence",
  {
    id: text().primaryKey().notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    runId: text("run_id").notNull(),
    checkId: text("check_id").notNull(),
    attempt: integer().notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text().notNull(),
    displayName: text("display_name").notNull(),
    headCommit: text("head_commit").notNull(),
    createdAt: integer("created_at").notNull(),
    assetUrl: text("asset_url"),
  },
  (table) => [
    index("evidence_item").on(table.itemId, table.createdAt),
    check("evidence_check_1", sql`attempt>=1`),
    check(
      "evidence_check_2",
      sql`media_type IN ('video/webm','video/mp4','image/png','image/jpeg','image/webp')`,
    ),
    check("evidence_check_3", sql`size_bytes>0`),
    check("evidence_check_4", sql`length(sha256)=64`),
  ],
);

export const closeoutRound = sqliteTable(
  "closeout_round",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    head: text().notNull(),
    retryBaseline: text("retry_baseline").notNull(),
    startedAt: integer("started_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.head], name: "closeout_round_item_id_head_pk" }),
    check("closeout_round_check_1", sql`json_valid(retry_baseline)`),
  ],
);

export const ciRound = sqliteTable(
  "ci_round",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    head: text().notNull(),
    runId: text("run_id"),
    next: text().notNull(),
    fix: integer(),
    fixLimit: integer("fix_limit").notNull(),
    checks: text().notNull(),
    recordedAt: integer("recorded_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.head], name: "ci_round_item_id_head_pk" }),
    check("ci_round_check_1", sql`next IN ('agent','asked','failed')`),
    check("ci_round_check_2", sql`fix IS NULL OR fix >= 1`),
    check("ci_round_check_3", sql`fix_limit >= 0`),
    check("ci_round_check_4", sql`json_valid(checks)`),
  ],
);

export const visualReview = sqliteTable(
  "visual_review",
  {
    questionId: text("question_id").primaryKey().notNull(),
    itemId: text("item_id").notNull(),
    checkId: text("check_id").notNull(),
    evidenceIds: text("evidence_ids").notNull(),
    createdAt: integer("created_at").notNull(),
    kind: text().default("review").notNull(),
    outcome: text(),
    answeredBy: text("answered_by"),
    answeredAt: integer("answered_at"),
    feedback: text(),
    headCommit: text("head_commit"),
    carried: text(),
  },
  (table) => [
    index("visual_review_item").on(table.itemId, table.checkId),
    check("visual_review_check_1", sql`json_valid(evidence_ids)`),
    check("visual_review_check_2", sql`kind IN ('review','continue')`),
    check(
      "visual_review_check_3",
      sql`outcome IS NULL OR outcome IN ('accepted','changes_requested','stale','continued')`,
    ),
    check("visual_review_check_4", sql`carried IS NULL OR json_valid(carried)`),
  ],
);

export const visualReviewMark = sqliteTable(
  "visual_review_mark",
  {
    id: text().primaryKey().notNull(),
    questionId: text("question_id")
      .notNull()
      .references(() => visualReview.questionId),
    evidenceId: text("evidence_id")
      .notNull()
      .references(() => evidence.id),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("visual_review_mark_question").on(table.questionId)],
);

export const evidenceObject = sqliteTable("evidence_object", {
  id: text().primaryKey().notNull(),
  prefix: text().notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storedAt: integer("stored_at").notNull(),
});

export const closeoutEvidenceObject = sqliteTable(
  "closeout_evidence_object",
  {
    task: text().notNull(),
    path: text().notNull(),
    prefix: text().notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text().notNull(),
    modifiedAt: integer("modified_at").notNull(),
    storedAt: integer("stored_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.task, table.path] })],
);

export const candidateRisk = sqliteTable(
  "candidate_risk",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    tier: text().notNull(),
    paths: text().notNull(),
    classifiedAt: integer("classified_at").notNull(),
    matches: text(),
  },
  (table) => [
    primaryKey({
      columns: [table.itemId, table.headSha],
      name: "candidate_risk_item_id_head_sha_pk",
    }),
    check("candidate_risk_check_1", sql`tier IN ('high', 'normal')`),
    check("candidate_risk_check_2", sql`json_valid(paths)`),
    check("candidate_risk_check_3", sql`matches IS NULL OR json_valid(matches)`),
  ],
);

export const closeoutBypassCheck = sqliteTable(
  "closeout_bypass_check",
  {
    questionId: text("question_id")
      .notNull()
      .references(() => question.id),
    checkId: text("check_id").notNull(),
    kind: text().notNull(),
    state: text().notNull(),
    attempt: integer(),
    message: text().notNull(),
    ordinal: integer().notNull(),
    reason: text(),
    approvedBy: text("approved_by"),
    approvedByName: text("approved_by_name"),
    approvedAt: integer("approved_at"),
  },
  (table) => [
    primaryKey({
      columns: [table.questionId, table.checkId],
      name: "closeout_bypass_check_question_id_check_id_pk",
    }),
  ],
);

export const runReviewRounds = sqliteTable(
  "run_review_rounds",
  {
    runId: text("run_id")
      .primaryKey()
      .notNull()
      .references(() => run.id),
    rounds: integer().notNull(),
  },
  () => [check("run_review_rounds_check_1", sql`rounds >= 0`)],
);

export const reviewEscape = sqliteTable(
  "review_escape",
  {
    id: integer().primaryKey(),
    triggerKey: text("trigger_key").notNull(),
    itemId: text("item_id").notNull(),
    trigger: text().notNull(),
    acceptedHead: text("accepted_head").notNull(),
    pullNumber: integer("pull_number"),
    detail: text().notNull(),
    recordedAt: integer("recorded_at").notNull(),
    fixHead: text("fix_head"),
    files: text(),
    isEscape: integer("is_escape"),
    notEscapeReason: text("not_escape_reason"),
    settledAt: integer("settled_at"),
  },
  (table) => [
    unique().on(table.triggerKey),
    index("review_escape_item_open").on(table.itemId, table.settledAt),
    check("review_escape_check_1", sql`trigger IN ('ci', 'review', 'comment')`),
    check("review_escape_check_2", sql`json_valid(detail)`),
    check("review_escape_check_3", sql`files IS NULL OR json_valid(files)`),
    check("review_escape_check_4", sql`is_escape IN (0, 1)`),
    check(
      "review_escape_check_5",
      sql`not_escape_reason IN ('flake', 'tests_docs_format', 'no_change', 'unreviewed')`,
    ),
  ],
);

export const riskFix = sqliteTable(
  "risk_fix",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    headSha: text("head_sha").notNull(),
    approvedHead: text("approved_head").notNull(),
    approvedQuestionId: text("approved_question_id").notNull(),
    changed: text().notNull(),
    paths: text().notNull(),
    recordedAt: integer("recorded_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.headSha], name: "risk_fix_item_id_head_sha_pk" }),
    check("risk_fix_check_1", sql`json_valid(changed)`),
    check("risk_fix_check_2", sql`json_valid(paths)`),
  ],
);

export const openFindings = sqliteTable("open_findings", {
  itemId: text("item_id")
    .primaryKey()
    .notNull()
    .references(() => workItem.id),
  headSha: text("head_sha").notNull(),
  line: text().notNull(),
  recordedAt: integer("recorded_at").notNull(),
});

export const reviewFindingIssue = sqliteTable(
  "review_finding_issue",
  {
    key: text().primaryKey(),
    repository: text().notNull(),
    path: text().notNull(),
    lines: text().notNull(),
    linearIssueId: text("linear_issue_id").notNull(),
    identifier: text().notNull(),
    url: text(),
    itemId: text("item_id"),
    filedBy: text("filed_by"),
    filedAt: integer("filed_at").notNull(),
  },
  () => [check("review_finding_issue_check_1", sql`length(key)=64`)],
);

export const candidatePaths = sqliteTable(
  "candidate_paths",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    headSha: text("head_sha").notNull(),
    paths: text().notNull(),
    recordedAt: integer("recorded_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.itemId, table.headSha],
      name: "candidate_paths_item_id_head_sha_pk",
    }),
    index("candidate_paths_item").on(table.itemId, table.recordedAt),
    check("candidate_paths_check_1", sql`json_valid(paths)`),
  ],
);

export const reviewFinding = sqliteTable(
  "review_finding",
  {
    id: integer().primaryKey(),
    dedupeKey: text("dedupe_key").notNull(),
    repository: text().notNull(),
    path: text().notNull(),
    lines: text().notNull(),
    firstLine: integer("first_line"),
    severity: text().notNull(),
    review: text().notNull(),
    text: text().notNull(),
    bugClass: text("bug_class").notNull(),
    why: text().notNull(),
    firstItemId: text("first_item_id")
      .notNull()
      .references(() => workItem.id),
    firstHead: text("first_head").notNull(),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastItemId: text("last_item_id")
      .notNull()
      .references(() => workItem.id),
    lastHead: text("last_head").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    itemCount: integer("item_count").default(1).notNull(),
    status: text().default("open").notNull(),
    statusBy: text("status_by"),
    statusAt: integer("status_at"),
    statusReason: text("status_reason"),
    filedIssue: text("filed_issue"),
  },
  (table) => [
    unique().on(table.dedupeKey),
    index("review_finding_last_seen").on(table.status, sql`last_seen_at DESC`),
    index("review_finding_path").on(table.repository, table.review, table.path),
    check("review_finding_check_1", sql`severity IN ('P0', 'P1', 'P2', 'P3')`),
    check("review_finding_check_2", sql`why IN ('pre-existing', 'below failOn', 'meets failOn')`),
    check("review_finding_check_3", sql`status IN ('open', 'filed', 'dismissed', 'gone')`),
  ],
);

export const reviewFindingItem = sqliteTable(
  "review_finding_item",
  {
    findingId: integer("finding_id")
      .notNull()
      .references(() => reviewFinding.id, { onDelete: "cascade" }),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    headSha: text("head_sha").notNull(),
    seenAt: integer("seen_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.findingId, table.itemId],
      name: "review_finding_item_finding_id_item_id_pk",
    }),
    index("review_finding_item_item").on(table.itemId),
  ],
);

export const findingGroupRun = sqliteTable(
  "finding_group_run",
  {
    id: text().primaryKey().notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    day: text().notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    fingerprint: text().notNull(),
    status: text().notNull(),
    tokens: integer(),
    groupCount: integer("group_count").default(0).notNull(),
    error: text(),
    findingCursor: integer("finding_cursor").default(0).notNull(),
    issueCursor: integer("issue_cursor").default(0).notNull(),
    skipReason: text("skip_reason"),
  },
  (table) => [
    unique().on(table.workspaceId, table.day),
    check("finding_group_run_check_1", sql`status IN ('running','completed','failed')`),
  ],
);

export const findingGroup = sqliteTable(
  "finding_group",
  {
    id: text().primaryKey().notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    repository: text().notNull(),
    teamId: text("team_id").notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    scope: text().notNull(),
    suggestedIssue: text("suggested_issue"),
    memberIds: text("member_ids").notNull(),
    createdAt: integer("created_at").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => findingGroupRun.id),
    status: text().default("open").notNull(),
    statusReason: text("status_reason"),
    statusBy: text("status_by"),
    statusAt: integer("status_at"),
    filedIssue: text("filed_issue"),
    action: text(),
  },
  (table) => [
    index("finding_group_workspace").on(table.workspaceId, table.status),
    check("finding_group_check_1", sql`json_valid(member_ids)`),
    check("finding_group_check_2", sql`status IN ('open','filed','added','dismissed')`),
    check("finding_group_check_3", sql`action IS NULL OR action IN ('file','add','dismiss')`),
  ],
);

export const reviewReply = sqliteTable(
  "review_reply",
  {
    id: integer().primaryKey(),
    itemId: text("item_id").notNull(),
    restartKey: text("restart_key").notNull(),
    number: integer().notNull(),
    pullNumber: integer("pull_number").notNull(),
    target: text().notNull(),
    commentId: integer("comment_id"),
    threadId: text("thread_id"),
    author: text(),
    excerpt: text().notNull(),
    recordedAt: integer("recorded_at").notNull(),
    outcome: text(),
    reply: text(),
    reportedAt: integer("reported_at"),
    repliedAt: integer("replied_at"),
    resolvedAt: integer("resolved_at"),
  },
  (table) => [
    unique().on(table.restartKey, table.number),
    index("review_reply_item_open").on(table.itemId, table.repliedAt),
    check("review_reply_check_1", sql`number >= 1`),
    check("review_reply_check_2", sql`target IN ('thread', 'review', 'conversation')`),
    check(
      "review_reply_check_3",
      sql`outcome IN ('fixed', 'answered', 'not_changed', 'unreported')`,
    ),
  ],
);

export const findingGroupingOff = sqliteTable("finding_grouping_off", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .notNull()
    .references(() => workspace.id),
});

export const riskAutoContext = sqliteTable(
  "risk_auto_context",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id, { onDelete: "cascade" }),
    head: text().notNull(),
    context: text().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.head], name: "risk_auto_context_item_id_head_pk" }),
  ],
);

export const closeoutRetryWindow = sqliteTable(
  "closeout_retry_window",
  {
    jobId: integer("job_id")
      .notNull()
      .references(() => job.id),
    activationId: integer("activation_id").notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    retryBaseline: text("retry_baseline").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.jobId, table.activationId],
      name: "closeout_retry_window_job_id_activation_id_pk",
    }),
    check("closeout_retry_window_check_1", sql`json_valid(retry_baseline)`),
  ],
);

export const ciRerun = sqliteTable(
  "ci_rerun",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id, { onDelete: "cascade" }),
    headSha: text("head_sha").notNull(),
    runIds: text("run_ids").notNull(),
    reason: text().notNull(),
    at: integer().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.headSha], name: "ci_rerun_item_id_head_sha_pk" }),
    check("ci_rerun_check_1", sql`json_valid(run_ids)`),
    check("ci_rerun_check_2", sql`length(reason) BETWEEN 1 AND 2000`),
  ],
);

export const reviewFindingIssueClaim = sqliteTable(
  "review_finding_issue_claim",
  {
    key: text().primaryKey().notNull(),
    findingKey: text("finding_key").notNull(),
    itemId: text("item_id"),
    claimedBy: text("claimed_by"),
    claimedAt: integer("claimed_at").notNull(),
  },
  (table) => [
    index("review_finding_issue_claim_finding").on(table.findingKey),
    check("review_finding_issue_claim_check_1", sql`length(key)=64`),
  ],
);

export const suggestedFinding = sqliteTable(
  "suggested_finding",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    findingId: text("finding_id").notNull(),
    reviewId: text("review_id").notNull(),
    location: text().notNull(),
    severity: text().notNull(),
    explanation: text().notNull(),
    handedAt: integer("handed_at").notNull(),
    decision: text(),
    reason: text(),
    head: text(),
    decidedAt: integer("decided_at"),
  },
  (table) => [
    primaryKey({
      columns: [table.itemId, table.findingId],
      name: "suggested_finding_item_id_finding_id_pk",
    }),
    check("suggested_finding_check_1", sql`decision IN ('fixed','declined')`),
    check("suggested_finding_check_2", sql`(decision IS NULL) = (decided_at IS NULL)`),
  ],
);

export const suggestionTurn = sqliteTable(
  "suggestion_turn",
  {
    itemId: text("item_id")
      .primaryKey()
      .notNull()
      .references(() => workItem.id),
    outcome: text().notNull(),
    reason: text(),
    head: text().notNull(),
    recordedAt: integer("recorded_at").notNull(),
  },
  () => [check("suggestion_turn_check_1", sql`outcome IN ('started','skipped')`)],
);

export const closeoutPolicyOutage = sqliteTable("closeout_policy_outage", {
  repository: text().primaryKey().notNull(),
  startedAt: integer("started_at").notNull(),
  error: text().notNull(),
  policyPath: text("policy_path").notNull(),
  mainSha: text("main_sha").notNull(),
  changedBySha: text("changed_by_sha"),
  questionId: text("question_id"),
  questionItemId: text("question_item_id"),
});

export const closeoutPolicyBlock = sqliteTable(
  "closeout_policy_block",
  {
    questionId: text("question_id").primaryKey().notNull(),
    itemId: text("item_id").notNull(),
    repository: text().notNull(),
    cause: text().notNull(),
    error: text().notNull(),
    policyPath: text("policy_path").notNull(),
    mainSha: text("main_sha").notNull(),
    changedBySha: text("changed_by_sha"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("closeout_policy_block_repository").on(table.repository),
    check("closeout_policy_block_check_1", sql`cause = 'policy_unreadable'`),
  ],
);
