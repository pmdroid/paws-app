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
import { workItem } from "./items";

export const githubDelivery = sqliteTable(
  "github_delivery",
  {
    deliveryId: text("delivery_id").primaryKey().notNull(),
    event: text().notNull(),
    payload: text().notNull(),
    receivedAt: integer("received_at").notNull(),
  },
  (table) => [index("github_delivery_received").on(table.receivedAt)],
);

export const remoteMergeFact = sqliteTable(
  "remote_merge_fact",
  {
    itemId: text("item_id")
      .primaryKey()
      .notNull()
      .references(() => workItem.id),
    repositoryOwner: text("repository_owner").notNull(),
    repositoryName: text("repository_name").notNull(),
    pullNumber: integer("pull_number").notNull(),
    pullUrl: text("pull_url"),
    mergeSha: text("merge_sha"),
    confirmedAt: integer("confirmed_at").notNull(),
  },
  () => [
    check("remote_merge_fact_check_1", sql`length(repository_owner) > 0`),
    check("remote_merge_fact_check_2", sql`length(repository_name) > 0`),
    check("remote_merge_fact_check_3", sql`pull_number > 0`),
    check("remote_merge_fact_check_4", sql`confirmed_at >= 0`),
  ],
);

export const githubIntegrationHold = sqliteTable(
  "github_integration_hold",
  {
    questionId: text("question_id")
      .primaryKey()
      .notNull()
      .references(() => question.id),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    phase: text().notNull(),
    itemVersion: integer("item_version").notNull(),
    sessionGeneration: integer("session_generation").notNull(),
    currentRunId: text("current_run_id"),
    checkpoint: text().notNull(),
    authority: text().notNull(),
    status: text().default("pending").notNull(),
  },
  (table) => [
    index("github_integration_hold_pending").on(table.status, table.itemId),
    check("github_integration_hold_check_1", sql`phase IN ('initial','publication')`),
    check("github_integration_hold_check_2", sql`status IN ('pending','verified','revoked')`),
  ],
);

export const repositoryCatalog = sqliteTable("repository_catalog", {
  repository: text().primaryKey().notNull(),
  owner: text().notNull(),
  repo: text().notNull(),
  remoteUrl: text("remote_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  refreshedAt: integer("refreshed_at").notNull(),
});

export const pullRequestDraft = sqliteTable("pull_request_draft", {
  itemId: text("item_id").primaryKey().notNull(),
  title: text().notNull(),
  body: text().notNull(),
  remainingJson: text("remaining_json"),
  updatedAt: integer("updated_at").notNull(),
});

export const mergeQueueEntry = sqliteTable(
  "merge_queue_entry",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    repository: text().notNull(),
    readyAt: integer("ready_at").notNull(),
    notifiedPosition: integer("notified_position"),
    kept: integer().default(0).notNull(),
    lane: text().default("").notNull(),
  },
  (table) => [
    unique().on(table.itemId),
    index("merge_queue_entry_lane").on(table.repository, table.lane, table.readyAt, table.id),
    index("merge_queue_entry_repository").on(table.repository, table.readyAt, table.id),
    check("merge_queue_entry_check_1", sql`kept IN (0, 1)`),
  ],
);

export const pullReview = sqliteTable(
  "pull_review",
  {
    reviewId: integer("review_id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    state: text().notNull(),
    pullNumber: integer("pull_number").notNull(),
    head: text(),
    reviewer: text(),
    body: text().notNull(),
    receivedAt: integer("received_at").notNull(),
    handledAt: integer("handled_at"),
    outcome: text(),
  },
  (table) => [
    index("pull_review_open")
      .on(table.itemId)
      .where(sql`handled_at IS NULL`),
    check("pull_review_check_1", sql`state IN ('changes_requested','commented')`),
    check("pull_review_check_2", sql`pull_number > 0`),
    check(
      "pull_review_check_3",
      sql`outcome IS NULL OR outcome IN ('restarted','asked','posted','dropped')`,
    ),
  ],
);

export const pullComment = sqliteTable(
  "pull_comment",
  {
    source: text().notNull(),
    commentId: integer("comment_id").notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    pullNumber: integer("pull_number").notNull(),
    reviewId: integer("review_id"),
    author: text(),
    body: text().notNull(),
    path: text(),
    line: integer(),
    receivedAt: integer("received_at").notNull(),
    handledAt: integer("handled_at"),
    outcome: text(),
  },
  (table) => [
    primaryKey({
      columns: [table.source, table.commentId],
      name: "pull_comment_source_comment_id_pk",
    }),
    index("pull_comment_open")
      .on(table.itemId)
      .where(sql`handled_at IS NULL`),
    check("pull_comment_check_1", sql`source IN ('review','inline','conversation')`),
    check("pull_comment_check_2", sql`pull_number > 0`),
    check(
      "pull_comment_check_3",
      sql`outcome IS NULL OR outcome IN ('restarted','asked','dropped','covered')`,
    ),
  ],
);

export const mergeCarriedAccept = sqliteTable(
  "merge_carried_accept",
  {
    itemId: text("item_id").notNull(),
    head: text().notNull(),
    acceptedHead: text("accepted_head").notNull(),
    base: text().notNull(),
    recordedAt: integer("recorded_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.itemId, table.head],
      name: "merge_carried_accept_item_id_head_pk",
    }),
  ],
);

export const pushOutage = sqliteTable("push_outage", {
  repository: text().primaryKey().notNull(),
  startedAt: integer("started_at").notNull(),
  lastError: text("last_error").notNull(),
  lastFailedAt: integer("last_failed_at").notNull(),
  failedProbes: integer("failed_probes").default(0).notNull(),
  nextProbeAt: integer("next_probe_at").notNull(),
  probeJobId: integer("probe_job_id"),
  installationUrl: text("installation_url"),
  questionId: text("question_id"),
});

export const mergeCall = sqliteTable("merge_call", {
  itemId: text("item_id")
    .primaryKey()
    .notNull()
    .references(() => workItem.id),
  headSha: text("head_sha").notNull(),
  startedAt: integer("started_at").notNull(),
});

export const repositoryMergeLock = sqliteTable("repository_merge_lock", {
  repository: text().primaryKey().notNull(),
  holder: text().notNull(),
  itemId: text("item_id").notNull(),
  jobId: integer("job_id").notNull(),
  instanceId: text("instance_id"),
  acquiredAt: integer("acquired_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const rebaseReturn = sqliteTable(
  "rebase_return",
  {
    jobId: integer("job_id").notNull(),
    activationId: integer("activation_id").notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    candidate: text(),
    reason: text().notNull(),
    base: text(),
    files: text(),
    recordedAt: integer("recorded_at"),
  },
  (table) => [
    primaryKey({
      columns: [table.jobId, table.activationId],
      name: "rebase_return_job_id_activation_id_pk",
    }),
    index("rebase_return_item").on(table.itemId, table.activationId),
    check("rebase_return_check_1", sql`reason IN ('merge','github_queue','linear','push')`),
    check("rebase_return_check_2", sql`files IS NULL OR json_valid(files)`),
  ],
);

export const pullCiFailure = sqliteTable(
  "pull_ci_failure",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id, { onDelete: "cascade" }),
    head: text().notNull(),
    pullNumber: integer("pull_number").notNull(),
    itemVersion: integer("item_version").notNull(),
    failedChecks: text("failed_checks").notNull(),
    checks: text().notNull(),
    observedAt: integer("observed_at").notNull(),
    laneFirstFailureAt: integer("lane_first_failure_at"),
    handledAt: integer("handled_at"),
    outcome: text(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.head], name: "pull_ci_failure_item_id_head_pk" }),
    index("pull_ci_failure_pending")
      .on(table.itemId)
      .where(sql`handled_at IS NULL`),
    check("pull_ci_failure_check_1", sql`json_valid(failed_checks)`),
    check("pull_ci_failure_check_2", sql`json_valid(checks)`),
    check(
      "pull_ci_failure_check_3",
      sql`outcome IS NULL OR outcome IN ('restarted','asked','dropped','cleared')`,
    ),
  ],
);

export const checkpointRefCleanup = sqliteTable("checkpoint_ref_cleanup", {
  itemId: text("item_id")
    .primaryKey()
    .notNull()
    .references(() => workItem.id, { onDelete: "cascade" }),
  endedAt: integer("ended_at").notNull(),
});

export const pullRequestText = sqliteTable("pull_request_text", {
  itemId: text("item_id").primaryKey().notNull(),
  title: text().notNull(),
  body: text().notNull(),
  evidence: text().notNull(),
  updatedAt: integer("updated_at").notNull(),
});
