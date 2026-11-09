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
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { question } from "./asks";
import { run, workItem } from "./items";
import { workspace } from "./workspace";
import { job } from "./jobs";

export const closeoutProgress = pgTable(
  "closeout_progress",
  {
    id: text().primaryKey(),
    itemId: text("item_id").notNull(),
    taskId: text("task_id").notNull(),
    base: text().notNull(),
    head: text().notNull(),
    policyDigest: text("policy_digest").notNull(),
    policyPath: text("policy_path"),
    decision: text(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    finishedAt: bigint("finished_at", { mode: "number" }),
    recheckDigest: text("recheck_digest"),
  },
  (table) => [index("closeout_progress_item").on(table.itemId, table.updatedAt)],
);

export const closeoutStep = pgTable(
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
    attempt: bigint({ mode: "number" }).notNull(),
    timeoutSeconds: bigint("timeout_seconds", { mode: "number" }),
    startedAt: bigint("started_at", { mode: "number" }),
    finishedAt: bigint("finished_at", { mode: "number" }),
    exitCode: bigint("exit_code", { mode: "number" }),
    timedOut: integer("timed_out").default(0).notNull(),
    timeoutReason: text("timeout_reason"),
    stdout: text().default("").notNull(),
    stderr: text().default("").notNull(),
    truncated: integer().default(0).notNull(),
    logPath: text("log_path"),
    evidencePath: text("evidence_path"),
    findings: text(),
    ordinal: bigint({ mode: "number" }).notNull(),
    durationMs: bigint("duration_ms", { mode: "number" }),
    tokens: bigint({ mode: "number" }),
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

export const closeoutRecovery = pgTable(
  "closeout_recovery",
  {
    questionId: text("question_id")
      .primaryKey()
      .references(() => question.id),
    taskId: text("task_id").notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    base: text().notNull(),
    head: text().notNull(),
    policyDigest: text("policy_digest").notNull(),
    failedChecks: jsonb("failed_checks").notNull(),
    retryBaseline: jsonb("retry_baseline").notNull(),
    summary: text().notNull(),
  },
  (table) => [index("closeout_recovery_item").on(table.itemId)],
);

export const evidence = pgTable(
  "evidence",
  {
    id: text().primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    runId: text("run_id").notNull(),
    checkId: text("check_id").notNull(),
    attempt: bigint({ mode: "number" }).notNull(),
    mediaType: text("media_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text().notNull(),
    displayName: text("display_name").notNull(),
    headCommit: text("head_commit").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
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

export const closeoutRound = pgTable(
  "closeout_round",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    head: text().notNull(),
    retryBaseline: jsonb("retry_baseline").notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.head], name: "closeout_round_item_id_head_pk" }),
  ],
);

export const ciRound = pgTable(
  "ci_round",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    head: text().notNull(),
    runId: text("run_id"),
    next: text().notNull(),
    fix: bigint({ mode: "number" }),
    fixLimit: bigint("fix_limit", { mode: "number" }).notNull(),
    checks: jsonb().notNull(),
    recordedAt: bigint("recorded_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.head], name: "ci_round_item_id_head_pk" }),
    check("ci_round_check_1", sql`next IN ('agent','asked','failed')`),
    check("ci_round_check_2", sql`fix IS NULL OR fix >= 1`),
    check("ci_round_check_3", sql`fix_limit >= 0`),
  ],
);

export const visualReview = pgTable(
  "visual_review",
  {
    questionId: text("question_id").primaryKey(),
    itemId: text("item_id").notNull(),
    checkId: text("check_id").notNull(),
    evidenceIds: jsonb("evidence_ids").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    kind: text().default("review").notNull(),
    outcome: text(),
    answeredBy: text("answered_by"),
    answeredAt: bigint("answered_at", { mode: "number" }),
    feedback: text(),
    headCommit: text("head_commit"),
    carried: jsonb(),
  },
  (table) => [
    index("visual_review_item").on(table.itemId, table.checkId),
    check("visual_review_check_2", sql`kind IN ('review','continue')`),
    check(
      "visual_review_check_3",
      sql`outcome IS NULL OR outcome IN ('accepted','changes_requested','stale','continued')`,
    ),
  ],
);

export const visualReviewMark = pgTable(
  "visual_review_mark",
  {
    id: text().primaryKey(),
    questionId: text("question_id")
      .notNull()
      .references(() => visualReview.questionId),
    evidenceId: text("evidence_id")
      .notNull()
      .references(() => evidence.id),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [index("visual_review_mark_question").on(table.questionId)],
);

export const evidenceObject = pgTable("evidence_object", {
  id: text().primaryKey(),
  prefix: text().notNull(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  storedAt: bigint("stored_at", { mode: "number" }).notNull(),
});

export const closeoutEvidenceObject = pgTable(
  "closeout_evidence_object",
  {
    task: text().notNull(),
    path: text().notNull(),
    prefix: text().notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text().notNull(),
    modifiedAt: bigint("modified_at", { mode: "number" }).notNull(),
    storedAt: bigint("stored_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.task, table.path],
      name: "closeout_evidence_object_task_path_pk",
    }),
  ],
);

export const candidateRisk = pgTable(
  "candidate_risk",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    headSha: text("head_sha").notNull(),
    baseSha: text("base_sha").notNull(),
    tier: text().notNull(),
    paths: jsonb().notNull(),
    classifiedAt: bigint("classified_at", { mode: "number" }).notNull(),
    matches: jsonb(),
  },
  (table) => [
    primaryKey({
      columns: [table.itemId, table.headSha],
      name: "candidate_risk_item_id_head_sha_pk",
    }),
    check("candidate_risk_check_1", sql`tier IN ('high', 'normal')`),
  ],
);

export const closeoutBypassCheck = pgTable(
  "closeout_bypass_check",
  {
    questionId: text("question_id")
      .notNull()
      .references(() => question.id),
    checkId: text("check_id").notNull(),
    kind: text().notNull(),
    state: text().notNull(),
    attempt: bigint({ mode: "number" }),
    message: text().notNull(),
    ordinal: bigint({ mode: "number" }).notNull(),
    reason: text(),
    approvedBy: text("approved_by"),
    approvedByName: text("approved_by_name"),
    approvedAt: bigint("approved_at", { mode: "number" }),
  },
  (table) => [
    primaryKey({
      columns: [table.questionId, table.checkId],
      name: "closeout_bypass_check_question_id_check_id_pk",
    }),
  ],
);

export const runReviewRounds = pgTable(
  "run_review_rounds",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => run.id),
    rounds: bigint({ mode: "number" }).notNull(),
  },
  () => [check("run_review_rounds_check_1", sql`rounds >= 0`)],
);

export const reviewEscape = pgTable(
  "review_escape",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    triggerKey: text("trigger_key").notNull(),
    itemId: text("item_id").notNull(),
    trigger: text().notNull(),
    acceptedHead: text("accepted_head").notNull(),
    pullNumber: bigint("pull_number", { mode: "number" }),
    detail: jsonb().notNull(),
    recordedAt: bigint("recorded_at", { mode: "number" }).notNull(),
    fixHead: text("fix_head"),
    files: jsonb(),
    isEscape: integer("is_escape"),
    notEscapeReason: text("not_escape_reason"),
    settledAt: bigint("settled_at", { mode: "number" }),
  },
  (table) => [
    unique().on(table.triggerKey),
    index("review_escape_item_open").on(table.itemId, table.settledAt),
    check("review_escape_check_1", sql`trigger IN ('ci', 'review', 'comment')`),
    check("review_escape_check_4", sql`is_escape IN (0, 1)`),
    check(
      "review_escape_check_5",
      sql`not_escape_reason IN ('flake', 'tests_docs_format', 'no_change', 'unreviewed')`,
    ),
  ],
);

export const riskFix = pgTable(
  "risk_fix",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    headSha: text("head_sha").notNull(),
    approvedHead: text("approved_head").notNull(),
    approvedQuestionId: text("approved_question_id").notNull(),
    changed: jsonb().notNull(),
    paths: jsonb().notNull(),
    recordedAt: bigint("recorded_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.headSha], name: "risk_fix_item_id_head_sha_pk" }),
  ],
);

export const openFindings = pgTable("open_findings", {
  itemId: text("item_id")
    .primaryKey()
    .references(() => workItem.id),
  headSha: text("head_sha").notNull(),
  line: text().notNull(),
  recordedAt: bigint("recorded_at", { mode: "number" }).notNull(),
});

export const reviewFindingIssue = pgTable(
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
    filedAt: bigint("filed_at", { mode: "number" }).notNull(),
  },
  () => [check("review_finding_issue_check_1", sql`length(key)=64`)],
);

export const candidatePaths = pgTable(
  "candidate_paths",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    headSha: text("head_sha").notNull(),
    paths: jsonb().notNull(),
    recordedAt: bigint("recorded_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.itemId, table.headSha],
      name: "candidate_paths_item_id_head_sha_pk",
    }),
    index("candidate_paths_item").on(table.itemId, table.recordedAt),
  ],
);

export const reviewFinding = pgTable(
  "review_finding",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    dedupeKey: text("dedupe_key").notNull(),
    repository: text().notNull(),
    path: text().notNull(),
    lines: text().notNull(),
    firstLine: bigint("first_line", { mode: "number" }),
    severity: text().notNull(),
    review: text().notNull(),
    text: text().notNull(),
    bugClass: text("bug_class").notNull(),
    why: text().notNull(),
    firstItemId: text("first_item_id")
      .notNull()
      .references(() => workItem.id),
    firstHead: text("first_head").notNull(),
    firstSeenAt: bigint("first_seen_at", { mode: "number" }).notNull(),
    lastItemId: text("last_item_id")
      .notNull()
      .references(() => workItem.id),
    lastHead: text("last_head").notNull(),
    lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
    itemCount: bigint("item_count", { mode: "number" }).default(1).notNull(),
    status: text().default("open").notNull(),
    statusBy: text("status_by"),
    statusAt: bigint("status_at", { mode: "number" }),
    statusReason: text("status_reason"),
    filedIssue: text("filed_issue"),
  },
  (table) => [
    unique().on(table.dedupeKey),
    index("review_finding_last_seen").on(table.status, table.lastSeenAt.desc()),
    index("review_finding_path").on(table.repository, table.review, table.path),
    check("review_finding_check_1", sql`severity IN ('P0', 'P1', 'P2', 'P3')`),
    check("review_finding_check_2", sql`why IN ('pre-existing', 'below failOn', 'meets failOn')`),
    check("review_finding_check_3", sql`status IN ('open', 'filed', 'dismissed', 'gone')`),
  ],
);

export const reviewFindingItem = pgTable(
  "review_finding_item",
  {
    findingId: bigint("finding_id", { mode: "number" })
      .notNull()
      .references(() => reviewFinding.id, { onDelete: "cascade" }),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    headSha: text("head_sha").notNull(),
    seenAt: bigint("seen_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.findingId, table.itemId],
      name: "review_finding_item_finding_id_item_id_pk",
    }),
    index("review_finding_item_item").on(table.itemId),
  ],
);

export const findingGroupRun = pgTable(
  "finding_group_run",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    day: text().notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    finishedAt: bigint("finished_at", { mode: "number" }),
    fingerprint: text().notNull(),
    status: text().notNull(),
    tokens: bigint({ mode: "number" }),
    groupCount: bigint("group_count", { mode: "number" }).default(0).notNull(),
    error: text(),
    findingCursor: bigint("finding_cursor", { mode: "number" }).default(0).notNull(),
    issueCursor: bigint("issue_cursor", { mode: "number" }).default(0).notNull(),
    skipReason: text("skip_reason"),
  },
  (table) => [
    unique().on(table.workspaceId, table.day),
    check("finding_group_run_check_1", sql`status IN ('running','completed','failed')`),
  ],
);

export const findingGroup = pgTable(
  "finding_group",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    repository: text().notNull(),
    teamId: text("team_id").notNull(),
    title: text().notNull(),
    summary: text().notNull(),
    scope: text().notNull(),
    suggestedIssue: text("suggested_issue"),
    memberIds: jsonb("member_ids").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => findingGroupRun.id),
    status: text().default("open").notNull(),
    statusReason: text("status_reason"),
    statusBy: text("status_by"),
    statusAt: bigint("status_at", { mode: "number" }),
    filedIssue: text("filed_issue"),
    action: text(),
  },
  (table) => [
    index("finding_group_workspace").on(table.workspaceId, table.status),
    check("finding_group_check_2", sql`status IN ('open','filed','added','dismissed')`),
    check("finding_group_check_3", sql`action IS NULL OR action IN ('file','add','dismiss')`),
  ],
);

export const reviewReply = pgTable(
  "review_reply",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    itemId: text("item_id").notNull(),
    restartKey: text("restart_key").notNull(),
    number: bigint({ mode: "number" }).notNull(),
    pullNumber: bigint("pull_number", { mode: "number" }).notNull(),
    target: text().notNull(),
    commentId: bigint("comment_id", { mode: "number" }),
    threadId: text("thread_id"),
    author: text(),
    excerpt: text().notNull(),
    recordedAt: bigint("recorded_at", { mode: "number" }).notNull(),
    outcome: text(),
    reply: text(),
    reportedAt: bigint("reported_at", { mode: "number" }),
    repliedAt: bigint("replied_at", { mode: "number" }),
    resolvedAt: bigint("resolved_at", { mode: "number" }),
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

export const findingGroupingOff = pgTable("finding_grouping_off", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspace.id),
});

export const riskAutoContext = pgTable(
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

export const closeoutRetryWindow = pgTable(
  "closeout_retry_window",
  {
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => job.id),
    activationId: bigint("activation_id", { mode: "number" }).notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    retryBaseline: jsonb("retry_baseline").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.jobId, table.activationId],
      name: "closeout_retry_window_job_id_activation_id_pk",
    }),
  ],
);

export const ciRerun = pgTable(
  "ci_rerun",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id, { onDelete: "cascade" }),
    headSha: text("head_sha").notNull(),
    runIds: jsonb("run_ids").notNull(),
    reason: text().notNull(),
    at: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.headSha], name: "ci_rerun_item_id_head_sha_pk" }),
    check("ci_rerun_check_2", sql`length(reason) BETWEEN 1 AND 2000`),
  ],
);

export const reviewFindingIssueClaim = pgTable(
  "review_finding_issue_claim",
  {
    key: text().primaryKey(),
    findingKey: text("finding_key").notNull(),
    itemId: text("item_id"),
    claimedBy: text("claimed_by"),
    claimedAt: bigint("claimed_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("review_finding_issue_claim_finding").on(table.findingKey),
    check("review_finding_issue_claim_check_1", sql`length(key)=64`),
  ],
);

export const suggestedFinding = pgTable(
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
    handedAt: bigint("handed_at", { mode: "number" }).notNull(),
    decision: text(),
    reason: text(),
    head: text(),
    decidedAt: bigint("decided_at", { mode: "number" }),
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

export const suggestionTurn = pgTable(
  "suggestion_turn",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => workItem.id),
    outcome: text().notNull(),
    reason: text(),
    head: text().notNull(),
    recordedAt: bigint("recorded_at", { mode: "number" }).notNull(),
  },
  () => [check("suggestion_turn_check_1", sql`outcome IN ('started','skipped')`)],
);

export const closeoutPolicyOutage = pgTable("closeout_policy_outage", {
  repository: text().primaryKey(),
  startedAt: bigint("started_at", { mode: "number" }).notNull(),
  error: text().notNull(),
  policyPath: text("policy_path").notNull(),
  mainSha: text("main_sha").notNull(),
  changedBySha: text("changed_by_sha"),
  questionId: text("question_id"),
  questionItemId: text("question_item_id"),
});

export const closeoutPolicyBlock = pgTable(
  "closeout_policy_block",
  {
    questionId: text("question_id").primaryKey(),
    itemId: text("item_id").notNull(),
    repository: text().notNull(),
    cause: text().notNull(),
    error: text().notNull(),
    policyPath: text("policy_path").notNull(),
    mainSha: text("main_sha").notNull(),
    changedBySha: text("changed_by_sha"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("closeout_policy_block_repository").on(table.repository),
    check("closeout_policy_block_check_1", sql`cause = 'policy_unreadable'`),
  ],
);
