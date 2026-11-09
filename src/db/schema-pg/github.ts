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
import { workItem } from "./items";
import { question } from "./asks";

export const githubDelivery = pgTable(
  "github_delivery",
  {
    deliveryId: text("delivery_id").primaryKey(),
    event: text().notNull(),
    payload: text().notNull(),
    receivedAt: bigint("received_at", { mode: "number" }).notNull(),
  },
  (table) => [index("github_delivery_received").on(table.receivedAt)],
);

export const remoteMergeFact = pgTable(
  "remote_merge_fact",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => workItem.id),
    repositoryOwner: text("repository_owner").notNull(),
    repositoryName: text("repository_name").notNull(),
    pullNumber: bigint("pull_number", { mode: "number" }).notNull(),
    pullUrl: text("pull_url"),
    mergeSha: text("merge_sha"),
    confirmedAt: bigint("confirmed_at", { mode: "number" }).notNull(),
  },
  () => [
    check("remote_merge_fact_check_1", sql`length(repository_owner) > 0`),
    check("remote_merge_fact_check_2", sql`length(repository_name) > 0`),
    check("remote_merge_fact_check_3", sql`pull_number > 0`),
    check("remote_merge_fact_check_4", sql`confirmed_at >= 0`),
  ],
);

export const githubIntegrationHold = pgTable(
  "github_integration_hold",
  {
    questionId: text("question_id")
      .primaryKey()
      .references(() => question.id),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    phase: text().notNull(),
    itemVersion: bigint("item_version", { mode: "number" }).notNull(),
    sessionGeneration: bigint("session_generation", { mode: "number" }).notNull(),
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

export const repositoryCatalog = pgTable("repository_catalog", {
  repository: text().primaryKey(),
  owner: text().notNull(),
  repo: text().notNull(),
  remoteUrl: text("remote_url").notNull(),
  defaultBranch: text("default_branch").notNull(),
  refreshedAt: bigint("refreshed_at", { mode: "number" }).notNull(),
});

export const pullRequestDraft = pgTable("pull_request_draft", {
  itemId: text("item_id").primaryKey(),
  title: text().notNull(),
  body: text().notNull(),
  remainingJson: text("remaining_json"),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});

export const mergeQueueEntry = pgTable(
  "merge_queue_entry",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    repository: text().notNull(),
    readyAt: bigint("ready_at", { mode: "number" }).notNull(),
    notifiedPosition: bigint("notified_position", { mode: "number" }),
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

export const pullReview = pgTable(
  "pull_review",
  {
    reviewId: bigint("review_id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    state: text().notNull(),
    pullNumber: bigint("pull_number", { mode: "number" }).notNull(),
    head: text(),
    reviewer: text(),
    body: text().notNull(),
    receivedAt: bigint("received_at", { mode: "number" }).notNull(),
    handledAt: bigint("handled_at", { mode: "number" }),
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

export const pullComment = pgTable(
  "pull_comment",
  {
    source: text().notNull(),
    commentId: bigint("comment_id", { mode: "number" }).notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    pullNumber: bigint("pull_number", { mode: "number" }).notNull(),
    reviewId: bigint("review_id", { mode: "number" }),
    author: text(),
    body: text().notNull(),
    path: text(),
    line: bigint({ mode: "number" }),
    receivedAt: bigint("received_at", { mode: "number" }).notNull(),
    handledAt: bigint("handled_at", { mode: "number" }),
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

export const mergeCarriedAccept = pgTable(
  "merge_carried_accept",
  {
    itemId: text("item_id").notNull(),
    head: text().notNull(),
    acceptedHead: text("accepted_head").notNull(),
    base: text().notNull(),
    recordedAt: bigint("recorded_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.itemId, table.head],
      name: "merge_carried_accept_item_id_head_pk",
    }),
  ],
);

export const pushOutage = pgTable("push_outage", {
  repository: text().primaryKey(),
  startedAt: bigint("started_at", { mode: "number" }).notNull(),
  lastError: text("last_error").notNull(),
  lastFailedAt: bigint("last_failed_at", { mode: "number" }).notNull(),
  failedProbes: bigint("failed_probes", { mode: "number" }).default(0).notNull(),
  nextProbeAt: bigint("next_probe_at", { mode: "number" }).notNull(),
  probeJobId: bigint("probe_job_id", { mode: "number" }),
  installationUrl: text("installation_url"),
  questionId: text("question_id"),
});

export const mergeCall = pgTable("merge_call", {
  itemId: text("item_id")
    .primaryKey()
    .references(() => workItem.id),
  headSha: text("head_sha").notNull(),
  startedAt: bigint("started_at", { mode: "number" }).notNull(),
});

export const rebaseReturn = pgTable(
  "rebase_return",
  {
    jobId: bigint("job_id", { mode: "number" }).notNull(),
    activationId: bigint("activation_id", { mode: "number" }).notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    candidate: text(),
    reason: text().notNull(),
    base: text(),
    files: jsonb(),
    recordedAt: bigint("recorded_at", { mode: "number" }),
  },
  (table) => [
    primaryKey({
      columns: [table.jobId, table.activationId],
      name: "rebase_return_job_id_activation_id_pk",
    }),
    index("rebase_return_item").on(table.itemId, table.activationId),
    check("rebase_return_check_1", sql`reason IN ('merge','github_queue','linear','push')`),
  ],
);

export const pullCiFailure = pgTable(
  "pull_ci_failure",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id, { onDelete: "cascade" }),
    head: text().notNull(),
    pullNumber: bigint("pull_number", { mode: "number" }).notNull(),
    itemVersion: bigint("item_version", { mode: "number" }).notNull(),
    failedChecks: jsonb("failed_checks").notNull(),
    checks: jsonb().notNull(),
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
    handledAt: bigint("handled_at", { mode: "number" }),
    outcome: text(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.head], name: "pull_ci_failure_item_id_head_pk" }),
    index("pull_ci_failure_pending")
      .on(table.itemId)
      .where(sql`handled_at IS NULL`),
    check(
      "pull_ci_failure_check_3",
      sql`outcome IS NULL OR outcome IN ('restarted','asked','dropped','cleared')`,
    ),
  ],
);

export const checkpointRefCleanup = pgTable("checkpoint_ref_cleanup", {
  itemId: text("item_id")
    .primaryKey()
    .references(() => workItem.id, { onDelete: "cascade" }),
  endedAt: bigint("ended_at", { mode: "number" }).notNull(),
});

export const pullRequestText = pgTable("pull_request_text", {
  itemId: text("item_id").primaryKey(),
  title: text().notNull(),
  body: text().notNull(),
  evidence: text().notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
