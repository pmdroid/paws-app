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
import { workItem } from "./items";
import { workspace } from "./workspace";

export const improvement = sqliteTable(
  "improvement",
  {
    id: text().primaryKey().notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    repository: text().notNull(),
    createdAt: integer("created_at").notNull(),
    version: integer().default(1).notNull(),
    reviewState: text("review_state").default("needs_review").notNull(),
    reviewedProposal: integer("reviewed_proposal"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: integer("reviewed_at"),
    reviewReason: text("review_reason"),
    intent: text(),
    intentIssueId: text("intent_issue_id"),
    evidenceComment: integer("evidence_comment").default(0).notNull(),
    issueId: text("issue_id"),
    issueIdentifier: text("issue_identifier"),
    issueUrl: text("issue_url"),
    issueConfirmedAt: integer("issue_confirmed_at"),
    implementationState: text("implementation_state").default("unknown").notNull(),
    implementationAt: integer("implementation_at"),
    verificationState: text("verification_state").default("unknown").notNull(),
    verificationAt: integer("verification_at"),
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
    check("improvement_check_9", sql`intent IS NOT 'link' OR intent_issue_id IS NOT NULL`),
    check("improvement_check_10", sql`evidence_comment = 0 OR intent = 'link'`),
  ],
);

export const improvementSource = sqliteTable(
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
    createdAt: integer("created_at").notNull(),
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

export const improvementProposal = sqliteTable(
  "improvement_proposal",
  {
    improvementId: text("improvement_id")
      .notNull()
      .references(() => improvement.id),
    version: integer().notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceKey: text("source_key").notNull(),
    title: text().notNull(),
    problem: text().notNull(),
    proposedChange: text("proposed_change").notNull(),
    actionStep: text("action_step").notNull(),
    verificationCriterion: text("verification_criterion").notNull(),
    evidence: text().notNull(),
    contentSha256: text("content_sha256").notNull(),
    createdAt: integer("created_at").notNull(),
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
    check(
      "improvement_proposal_check_4",
      sql`json_valid(evidence) AND json_type(evidence) = 'array'`,
    ),
    check("improvement_proposal_check_5", sql`length(content_sha256) = 64`),
  ],
);

export const improvementDecision = sqliteTable(
  "improvement_decision",
  {
    improvementId: text("improvement_id")
      .notNull()
      .references(() => improvement.id),
    version: integer().notNull(),
    reviewState: text("review_state").notNull(),
    proposalVersion: integer("proposal_version"),
    intent: text(),
    intentIssueId: text("intent_issue_id"),
    evidenceComment: integer("evidence_comment").notNull(),
    reason: text(),
    actor: text().notNull(),
    at: integer().notNull(),
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

export const improvementDelivery = sqliteTable(
  "improvement_delivery",
  {
    id: text().primaryKey().notNull(),
    improvementId: text("improvement_id")
      .notNull()
      .references(() => improvement.id),
    operation: text().notNull(),
    targetIssueId: text("target_issue_id"),
    state: text().notNull(),
    claimOwner: text("claim_owner"),
    claimExpiresAt: integer("claim_expires_at"),
    attempts: integer().default(0).notNull(),
    remoteId: text("remote_id"),
    remoteIdentifier: text("remote_identifier"),
    remoteUrl: text("remote_url"),
    error: text(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    targetTeamId: text("target_team_id"),
    content: text(),
    nextAttemptAt: integer("next_attempt_at"),
    blocked: text(),
    retryBase: integer("retry_base").default(0).notNull(),
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
    check("improvement_delivery_check_3", sql`content IS NULL OR json_valid(content)`),
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

export const improvementDeliveryAttempt = sqliteTable(
  "improvement_delivery_attempt",
  {
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => improvementDelivery.id),
    attempt: integer().notNull(),
    owner: text().notNull(),
    claimedAt: integer("claimed_at").notNull(),
    claimExpiresAt: integer("claim_expires_at").notNull(),
    outcome: text().default("claimed").notNull(),
    remoteId: text("remote_id"),
    remoteIdentifier: text("remote_identifier"),
    remoteUrl: text("remote_url"),
    error: text(),
    settledAt: integer("settled_at"),
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

export const improvementOutcome = sqliteTable(
  "improvement_outcome",
  {
    id: integer().primaryKey(),
    improvementId: text("improvement_id")
      .notNull()
      .references(() => improvement.id),
    track: text().notNull(),
    state: text().notNull(),
    evidence: text().notNull(),
    revision: text(),
    deployment: text(),
    actor: text().notNull(),
    recordedAt: integer("recorded_at").notNull(),
  },
  (table) => [
    index("improvement_outcome_improvement").on(table.improvementId, table.id),
    check("improvement_outcome_check_1", sql`track IN ('implementation','verification')`),
    check(
      "improvement_outcome_check_2",
      sql`json_valid(evidence) AND json_type(evidence) = 'array'`,
    ),
    check(
      "improvement_outcome_check_3",
      sql`track <> 'verification' OR state <> 'verified' OR json_array_length(evidence) > 0`,
    ),
  ],
);

export const improvementCriterion = sqliteTable(
  "improvement_criterion",
  {
    improvementId: text("improvement_id")
      .notNull()
      .references(() => improvement.id),
    revision: integer().notNull(),
    proposalVersion: integer("proposal_version").notNull(),
    criterion: text().notNull(),
    actor: text().notNull(),
    at: integer().notNull(),
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

export const improvementIssueSync = sqliteTable(
  "improvement_issue_sync",
  {
    improvementId: text("improvement_id")
      .primaryKey()
      .notNull()
      .references(() => improvement.id),
    issueId: text("issue_id").notNull(),
    status: text().notNull(),
    stateType: text("state_type"),
    teamId: text("team_id"),
    delegated: integer(),
    observedAt: integer("observed_at").notNull(),
    confirmedAt: integer("confirmed_at"),
  },
  () => [
    check(
      "improvement_issue_sync_check_1",
      sql`status IN ('available','missing','unauthorized','unavailable')`,
    ),
    check("improvement_issue_sync_check_2", sql`delegated IS NULL OR delegated IN (0,1)`),
  ],
);

export const improvementDelegation = sqliteTable(
  "improvement_delegation",
  {
    improvementId: text("improvement_id")
      .primaryKey()
      .notNull()
      .references(() => improvement.id),
    issueId: text("issue_id").notNull(),
    state: text().notNull(),
    sessionId: text("session_id"),
    error: text(),
    attempts: integer().notNull(),
    leaseExpiresAt: integer("lease_expires_at"),
    actor: text().notNull(),
    requestedAt: integer("requested_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
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

export const improvementSweep = sqliteTable("improvement_sweep", {
  improvementId: text("improvement_id")
    .primaryKey()
    .notNull()
    .references(() => improvement.id),
  checkedAt: integer("checked_at").notNull(),
});

export const improvementWork = sqliteTable("improvement_work", {
  improvementId: text("improvement_id")
    .primaryKey()
    .notNull()
    .references(() => improvement.id),
  issueId: text("issue_id").notNull(),
  itemId: text("item_id")
    .notNull()
    .references(() => workItem.id),
  boundAt: integer("bound_at").notNull(),
});

export const improvementAction = sqliteTable(
  "improvement_action",
  {
    id: integer().primaryKey(),
    improvementId: text("improvement_id")
      .notNull()
      .references(() => improvement.id),
    action: text().notNull(),
    version: integer().notNull(),
    prior: text().notNull(),
    detail: text().notNull(),
    actor: text().notNull(),
    at: integer().notNull(),
  },
  (table) => [
    index("improvement_action_improvement").on(table.improvementId, table.id),
    check(
      "improvement_action_check_1",
      sql`action IN ('delegate','verify','contradict','criterion','acknowledge','redelegate','return_to_review', 'follow_work')`,
    ),
    check("improvement_action_check_2", sql`json_valid(prior)`),
    check("improvement_action_check_3", sql`json_valid(detail)`),
  ],
);
