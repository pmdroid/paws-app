import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { citext, jsonb } from "./types";
import { workspace } from "./workspace";
import { workItem } from "./items";

export const improvement = pgTable(
  "improvement",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    repository: citext().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    version: bigint({ mode: "number" }).default(1).notNull(),
    reviewState: text("review_state").default("needs_review").notNull(),
    reviewedProposal: bigint("reviewed_proposal", { mode: "number" }),
    reviewedBy: text("reviewed_by"),
    reviewedAt: bigint("reviewed_at", { mode: "number" }),
    reviewReason: text("review_reason"),
    intent: text(),
    intentIssueId: text("intent_issue_id"),
    evidenceComment: integer("evidence_comment").default(0).notNull(),
    issueId: text("issue_id"),
    issueIdentifier: text("issue_identifier"),
    issueUrl: text("issue_url"),
    issueConfirmedAt: bigint("issue_confirmed_at", { mode: "number" }),
    implementationState: text("implementation_state").default("unknown").notNull(),
    implementationAt: bigint("implementation_at", { mode: "number" }),
    verificationState: text("verification_state").default("unknown").notNull(),
    verificationAt: bigint("verification_at", { mode: "number" }),
  },
  (table) => [
    index("improvement_issue")
      .on(table.workspaceId, table.issueId)
      .where(sql`issue_id IS NOT NULL`),
    index("improvement_workspace").on(table.workspaceId, table.reviewState),
    check("improvement_check_1", sql`version >= 1`),
    check("improvement_check_2", sql`review_state IN ('needs_review','accepted','rejected')`),
    check("improvement_check_3", sql`intent IS NULL OR intent IN ('create','link')`),
    check("improvement_check_4", sql`evidence_comment IN (0,1)`),
    check(
      "improvement_check_5",
      sql`implementation_state IN ('unknown','not_started','in_progress','blocked','merged','completed','canceled','stale')`,
    ),
    check(
      "improvement_check_6",
      sql`verification_state IN ('unknown','due','verified','contradicted')`,
    ),
    check(
      "improvement_check_7",
      sql`review_state <> 'accepted' OR (intent IS NOT NULL AND reviewed_proposal IS NOT NULL)`,
    ),
    check("improvement_check_8", sql`review_state <> 'rejected' OR review_reason IS NOT NULL`),
    check(
      "improvement_check_9",
      sql`intent IS DISTINCT FROM 'link' OR intent_issue_id IS NOT NULL`,
    ),
    check("improvement_check_10", sql`evidence_comment = 0 OR intent = 'link'`),
  ],
);

export const improvementSource = pgTable(
  "improvement_source",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    sourceKind: text("source_kind").notNull(),
    sourceKey: text("source_key").notNull(),
    improvementId: text("improvement_id")
      .notNull()
      .references(() => improvement.id),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.sourceKind, table.sourceKey],
      name: "improvement_source_workspace_id_source_kind_source_key_pk",
    }),
    check("improvement_source_check_1", sql`source_kind IN ('retro_item','daily_finding')`),
    check("improvement_source_check_2", sql`length(source_key) BETWEEN 1 AND 400`),
  ],
);

export const improvementProposal = pgTable(
  "improvement_proposal",
  {
    improvementId: text("improvement_id")
      .notNull()
      .references(() => improvement.id),
    version: bigint({ mode: "number" }).notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceKey: text("source_key").notNull(),
    title: text().notNull(),
    problem: text().notNull(),
    proposedChange: text("proposed_change").notNull(),
    actionStep: text("action_step").notNull(),
    verificationCriterion: text("verification_criterion").notNull(),
    evidence: jsonb().notNull(),
    contentSha256: text("content_sha256").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.improvementId, table.version],
      name: "improvement_proposal_improvement_id_version_pk",
    }),
    check("improvement_proposal_check_1", sql`version >= 1`),
    check("improvement_proposal_check_2", sql`length(title) BETWEEN 1 AND 300`),
    check(
      "improvement_proposal_check_3",
      sql`action_step IN ('automatic','rule','convention','decision','issue')`,
    ),
    check("improvement_proposal_check_4", sql`jsonb_typeof(evidence) = 'array'`),
    check("improvement_proposal_check_5", sql`length(content_sha256) = 64`),
  ],
);

export const improvementDecision = pgTable(
  "improvement_decision",
  {
    improvementId: text("improvement_id")
      .notNull()
      .references(() => improvement.id),
    version: bigint({ mode: "number" }).notNull(),
    reviewState: text("review_state").notNull(),
    proposalVersion: bigint("proposal_version", { mode: "number" }),
    intent: text(),
    intentIssueId: text("intent_issue_id"),
    evidenceComment: integer("evidence_comment").notNull(),
    reason: text(),
    actor: text().notNull(),
    at: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.improvementId, table.version],
      name: "improvement_decision_improvement_id_version_pk",
    }),
    check(
      "improvement_decision_check_1",
      sql`review_state IN ('needs_review','accepted','rejected')`,
    ),
    check("improvement_decision_check_2", sql`evidence_comment IN (0,1)`),
  ],
);

export const improvementDelivery = pgTable(
  "improvement_delivery",
  {
    id: text().primaryKey(),
    improvementId: text("improvement_id")
      .notNull()
      .references(() => improvement.id),
    operation: text().notNull(),
    targetIssueId: text("target_issue_id"),
    state: text().notNull(),
    claimOwner: text("claim_owner"),
    claimExpiresAt: bigint("claim_expires_at", { mode: "number" }),
    attempts: bigint({ mode: "number" }).default(0).notNull(),
    remoteId: text("remote_id"),
    remoteIdentifier: text("remote_identifier"),
    remoteUrl: text("remote_url"),
    error: text(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    targetTeamId: text("target_team_id"),
    content: jsonb(),
    nextAttemptAt: bigint("next_attempt_at", { mode: "number" }),
    blocked: text(),
    retryBase: bigint("retry_base", { mode: "number" }).default(0).notNull(),
  },
  (table) => [
    unique().on(table.improvementId, table.operation),
    index("improvement_delivery_open")
      .on(table.state)
      .where(sql`state IN ('pending','claimed','failed','unknown')`),
    check(
      "improvement_delivery_check_1",
      sql`operation IN ('create_issue','link_issue','evidence_comment')`,
    ),
    check(
      "improvement_delivery_check_2",
      sql`state IN ('pending','claimed','succeeded','failed','unknown')`,
    ),
    check(
      "improvement_delivery_check_4",
      sql`blocked IS NULL OR blocked IN ('destination','unauthorized','unavailable','conflict','attempts','workspace')`,
    ),
    check(
      "improvement_delivery_check_5",
      sql`operation = 'create_issue' OR target_issue_id IS NOT NULL`,
    ),
    check(
      "improvement_delivery_check_6",
      sql`state <> 'claimed' OR (claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL)`,
    ),
  ],
);

export const improvementDeliveryAttempt = pgTable(
  "improvement_delivery_attempt",
  {
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => improvementDelivery.id),
    attempt: bigint({ mode: "number" }).notNull(),
    owner: text().notNull(),
    claimedAt: bigint("claimed_at", { mode: "number" }).notNull(),
    claimExpiresAt: bigint("claim_expires_at", { mode: "number" }).notNull(),
    outcome: text().default("claimed").notNull(),
    remoteId: text("remote_id"),
    remoteIdentifier: text("remote_identifier"),
    remoteUrl: text("remote_url"),
    error: text(),
    settledAt: bigint("settled_at", { mode: "number" }),
  },
  (table) => [
    primaryKey({
      columns: [table.deliveryId, table.attempt],
      name: "improvement_delivery_attempt_delivery_id_attempt_pk",
    }),
    check("improvement_delivery_attempt_check_1", sql`attempt >= 1`),
    check(
      "improvement_delivery_attempt_check_2",
      sql`outcome IN ('claimed','succeeded','failed','unknown','expired')`,
    ),
  ],
);

export const improvementOutcome = pgTable(
  "improvement_outcome",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    improvementId: text("improvement_id")
      .notNull()
      .references(() => improvement.id),
    track: text().notNull(),
    state: text().notNull(),
    evidence: jsonb().notNull(),
    revision: text(),
    deployment: text(),
    actor: text().notNull(),
    recordedAt: bigint("recorded_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("improvement_outcome_improvement").on(table.improvementId, table.id),
    check("improvement_outcome_check_1", sql`track IN ('implementation','verification')`),
    check("improvement_outcome_check_2", sql`jsonb_typeof(evidence) = 'array'`),
    check(
      "improvement_outcome_check_3",
      sql`track <> 'verification' OR state <> 'verified' OR jsonb_array_length(evidence) > 0`,
    ),
  ],
);

export const improvementCriterion = pgTable(
  "improvement_criterion",
  {
    improvementId: text("improvement_id")
      .notNull()
      .references(() => improvement.id),
    revision: bigint({ mode: "number" }).notNull(),
    proposalVersion: bigint("proposal_version", { mode: "number" }).notNull(),
    criterion: text().notNull(),
    actor: text().notNull(),
    at: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.improvementId, table.revision],
      name: "improvement_criterion_improvement_id_revision_pk",
    }),
    check("improvement_criterion_check_1", sql`revision >= 1`),
    check("improvement_criterion_check_2", sql`length(criterion) BETWEEN 1 AND 1000`),
  ],
);

export const improvementIssueSync = pgTable(
  "improvement_issue_sync",
  {
    improvementId: text("improvement_id")
      .primaryKey()
      .references(() => improvement.id),
    issueId: text("issue_id").notNull(),
    status: text().notNull(),
    stateType: text("state_type"),
    teamId: text("team_id"),
    delegated: bigint({ mode: "number" }),
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
    confirmedAt: bigint("confirmed_at", { mode: "number" }),
  },
  () => [
    check(
      "improvement_issue_sync_check_1",
      sql`status IN ('available','missing','unauthorized','unavailable')`,
    ),
    check("improvement_issue_sync_check_2", sql`delegated IS NULL OR delegated IN (0,1)`),
  ],
);

export const improvementDelegation = pgTable(
  "improvement_delegation",
  {
    improvementId: text("improvement_id")
      .primaryKey()
      .references(() => improvement.id),
    issueId: text("issue_id").notNull(),
    state: text().notNull(),
    sessionId: text("session_id"),
    error: text(),
    attempts: bigint({ mode: "number" }).notNull(),
    leaseExpiresAt: bigint("lease_expires_at", { mode: "number" }),
    actor: text().notNull(),
    requestedAt: bigint("requested_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  () => [
    check(
      "improvement_delegation_check_1",
      sql`state IN ('requested','started','existing','failed')`,
    ),
    check("improvement_delegation_check_2", sql`attempts >= 0`),
    check(
      "improvement_delegation_check_3",
      sql`state <> 'requested' OR lease_expires_at IS NOT NULL`,
    ),
  ],
);

export const improvementSweep = pgTable("improvement_sweep", {
  improvementId: text("improvement_id")
    .primaryKey()
    .references(() => improvement.id),
  checkedAt: bigint("checked_at", { mode: "number" }).notNull(),
});

export const improvementWork = pgTable("improvement_work", {
  improvementId: text("improvement_id")
    .primaryKey()
    .references(() => improvement.id),
  issueId: text("issue_id").notNull(),
  itemId: text("item_id")
    .notNull()
    .references(() => workItem.id),
  boundAt: bigint("bound_at", { mode: "number" }).notNull(),
});

export const improvementAction = pgTable(
  "improvement_action",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    improvementId: text("improvement_id")
      .notNull()
      .references(() => improvement.id),
    action: text().notNull(),
    version: bigint({ mode: "number" }).notNull(),
    prior: jsonb().notNull(),
    detail: jsonb().notNull(),
    actor: text().notNull(),
    at: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    index("improvement_action_improvement").on(table.improvementId, table.id),
    check(
      "improvement_action_check_1",
      sql`action IN ('delegate','verify','contradict','criterion','acknowledge','redelegate','return_to_review', 'follow_work')`,
    ),
  ],
);
