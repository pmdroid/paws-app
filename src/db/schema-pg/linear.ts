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

export const linearSessionContext = pgTable("linear_session_context", {
  sessionId: text("session_id").primaryKey(),
  context: text().notNull(),
  richness: bigint({ mode: "number" }).notNull(),
  snapshotContext: text("snapshot_context"),
});

export const linearActivitySnapshot = pgTable(
  "linear_activity_snapshot",
  {
    id: text().primaryKey(),
    sessionId: text("session_id").notNull(),
    createdAt: text("created_at").notNull(),
    snapshot: jsonb().notNull(),
  },
  (table) => [index("linear_activity_session").on(table.sessionId, table.createdAt, table.id)],
);

export const linearSession = pgTable("linear_session", {
  sessionId: text("session_id").primaryKey(),
  issueId: text("issue_id"),
  organizationId: text("organization_id"),
  appUserId: text("app_user_id"),
  creatorId: text("creator_id"),
  activeItemId: text("active_item_id").references(() => workItem.id),
  generation: bigint({ mode: "number" }).default(0).notNull(),
  stoppedAt: bigint("stopped_at", { mode: "number" }),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
  oauthClientId: text("oauth_client_id"),
  teamId: text("team_id"),
  installationObservedAt: bigint("installation_observed_at", { mode: "number" }),
});

export const linearTurn = pgTable(
  "linear_turn",
  {
    ordinal: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    eventKey: text("event_key").notNull(),
    activityId: text("activity_id"),
    sessionId: text("session_id")
      .notNull()
      .references(() => linearSession.sessionId),
    actorId: text("actor_id"),
    body: text().notNull(),
    payload: jsonb().notNull(),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    receivedAt: bigint("received_at", { mode: "number" }).notNull(),
    itemId: text("item_id").references(() => workItem.id),
    state: text().default("pending").notNull(),
    announcedGeneration: bigint("announced_generation", { mode: "number" }),
  },
  (table) => [
    unique().on(table.eventKey),
    unique().on(table.activityId),
    index("linear_turn_pending").on(table.sessionId, table.state, table.createdAtMs, table.ordinal),
    check("linear_turn_check_2", sql`state IN ('pending','applied','cancelled')`),
  ],
);

export const linearArtifact = pgTable(
  "linear_artifact",
  {
    id: text().primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    runId: text("run_id").notNull(),
    path: text().notNull(),
    displayName: text("display_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    sha256: text().notNull(),
    requestVersion: bigint("request_version", { mode: "number" }).default(0).notNull(),
    state: text().notNull(),
    assetUrl: text("asset_url"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    identityHash: text("identity_hash"),
  },
  (table) => [
    unique().on(table.itemId, table.path, table.displayName, table.mimeType, table.sha256),
    check("linear_artifact_check_1", sql`state IN ('pending', 'uploaded', 'failed')`),
  ],
);

export const linearInput = pgTable(
  "linear_input",
  {
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    assetId: text("asset_id").notNull(),
    assetUrl: text("asset_url").notNull(),
    mimeType: text("mime_type").notNull(),
    size: bigint({ mode: "number" }).notNull(),
    sha256: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.sessionId, table.turnId, table.assetId],
      name: "linear_input_session_id_turn_id_asset_id_pk",
    }),
  ],
);

export const linearConversation = pgTable(
  "linear_conversation",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => workItem.id),
    entries: jsonb().notNull(),
    transcript: text(),
    transcriptOffset: bigint("transcript_offset", { mode: "number" }).default(0).notNull(),
    blocked: integer().default(0).notNull(),
    blockedAt: bigint("blocked_at", { mode: "number" }),
  },
  () => [check("linear_conversation_check_2", sql`blocked IN (0,1)`)],
);

export const linearStopReceipt = pgTable(
  "linear_stop_receipt",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => linearSession.sessionId),
    eventKey: text("event_key").notNull(),
    generation: bigint({ mode: "number" }).notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.sessionId, table.eventKey],
      name: "linear_stop_receipt_session_id_event_key_pk",
    }),
  ],
);

export const linearSessionCleanupBlock = pgTable("linear_session_cleanup_block", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => linearSession.sessionId),
});

export const linearArtifactAttempt = pgTable(
  "linear_artifact_attempt",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    identityHash: text("identity_hash").notNull(),
    version: bigint({ mode: "number" }).notNull(),
    completedVersion: bigint("completed_version", { mode: "number" }).default(0).notNull(),
    attachmentRequested: integer("attachment_requested").default(0).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.itemId, table.identityHash],
      name: "linear_artifact_attempt_item_id_identity_hash_pk",
    }),
    check("linear_artifact_attempt_check_1", sql`attachment_requested IN (0, 1)`),
  ],
);

export const linearAppRevocation = pgTable(
  "linear_app_revocation",
  {
    organizationId: text("organization_id").notNull(),
    oauthClientId: text("oauth_client_id").notNull(),
    revokedAt: bigint("revoked_at", { mode: "number" }).notNull(),
    generation: bigint({ mode: "number" }).default(1).notNull(),
    restoredAfter: bigint("restored_after", { mode: "number" }),
    restoredCredentialFingerprint: text("restored_credential_fingerprint"),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.oauthClientId],
      name: "linear_app_revocation_organization_id_oauth_client_id_pk",
    }),
  ],
);

export const linearTeamAccess = pgTable(
  "linear_team_access",
  {
    organizationId: text("organization_id").notNull(),
    oauthClientId: text("oauth_client_id").notNull(),
    appUserId: text("app_user_id").notNull(),
    teamId: text("team_id").notNull(),
    allowed: integer().notNull(),
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.oauthClientId, table.appUserId, table.teamId],
      name: "linear_team_access_organization_id_oauth_client_id_app_user_id_team_id_pk",
    }),
    check("linear_team_access_check_1", sql`allowed IN (0, 1)`),
  ],
);

export const linearInstallationPermission = pgTable(
  "linear_installation_permission",
  {
    organizationId: text("organization_id").notNull(),
    oauthClientId: text("oauth_client_id").notNull(),
    appUserId: text("app_user_id").notNull(),
    allPublicTeams: integer("all_public_teams").notNull(),
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.oauthClientId, table.appUserId],
      name: "linear_installation_permission_organization_id_oauth_client_id_app_user_id_pk",
    }),
    check("linear_installation_permission_check_1", sql`all_public_teams IN (0, 1)`),
  ],
);

export const linearAccessEvent = pgTable("linear_access_event", {
  eventKey: text("event_key").primaryKey(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const linearTaskDelegation = pgTable(
  "linear_task_delegation",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    issueId: text("issue_id").notNull(),
    teamId: text("team_id").notNull(),
    appUserId: text("app_user_id").notNull(),
    humanActorId: text("human_actor_id"),
  },
  (table) => [
    primaryKey({
      columns: [table.itemId, table.issueId],
      name: "linear_task_delegation_item_id_issue_id_pk",
    }),
  ],
);

export const linearIssueContext = pgTable(
  "linear_issue_context",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => linearSession.sessionId),
    issueId: text("issue_id").notNull(),
    observedAt: bigint("observed_at", { mode: "number" }).notNull(),
    context: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.sessionId, table.issueId],
      name: "linear_issue_context_session_id_issue_id_pk",
    }),
  ],
);

export const linearOutboxBackoff = pgTable(
  "linear_outbox_backoff",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    notBefore: bigint("not_before", { mode: "number" }).notNull(),
  },
  () => [check("linear_outbox_backoff_check_1", sql`id=1`)],
);

export const linearRequestBudget = pgTable("linear_request_budget", {
  workspace: text().primaryKey(),
  windowStart: bigint("window_start", { mode: "number" }).notNull(),
  spent: bigint({ mode: "number" }).notNull(),
  holdUntil: bigint("hold_until", { mode: "number" }),
  requestLimit: bigint("request_limit", { mode: "number" }),
});

export const linearRequestReservation = pgTable(
  "linear_request_reservation",
  {
    id: text().primaryKey(),
    workspace: text().notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  },
  (table) => [index("linear_request_reservation_workspace").on(table.workspace, table.expiresAt)],
);

export const linearActivityListing = pgTable("linear_activity_listing", {
  sessionId: text("session_id").primaryKey(),
  generation: bigint({ mode: "number" }).notNull(),
});

export const linearItemRequest = pgTable("linear_item_request", {
  itemId: text("item_id").primaryKey(),
  requests: bigint({ mode: "number" }).notNull(),
});

export const linearItemCallerRequest = pgTable(
  "linear_item_caller_request",
  {
    itemId: text("item_id").notNull(),
    caller: text().notNull(),
    requests: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.itemId, table.caller],
      name: "linear_item_caller_request_item_id_caller_pk",
    }),
  ],
);

export const linearComment = pgTable(
  "linear_comment",
  {
    commentId: text("comment_id").primaryKey(),
    issueId: text("issue_id").notNull(),
    organizationId: text("organization_id"),
    teamId: text("team_id"),
    authorId: text("author_id"),
    actorId: text("actor_id"),
    actorType: text("actor_type"),
    botActor: text("bot_actor"),
    onBehalfOf: text("on_behalf_of"),
    parentId: text("parent_id"),
    body: text().notNull(),
    createdAtMs: bigint("created_at_ms", { mode: "number" }).notNull(),
    updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
    receivedAt: bigint("received_at", { mode: "number" }).notNull(),
    source: text().notNull(),
    edited: integer().default(0).notNull(),
    removedAt: bigint("removed_at", { mode: "number" }),
    state: text().default("received").notNull(),
    reason: text(),
    authority: text(),
    itemId: text("item_id"),
    sessionId: text("session_id"),
    generation: bigint({ mode: "number" }),
    itemVersion: bigint("item_version", { mode: "number" }),
    via: text(),
    settledAt: bigint("settled_at", { mode: "number" }),
  },
  (table) => [
    index("linear_comment_issue").on(table.issueId, table.state),
    index("linear_comment_item").on(table.itemId, table.state),
    check("linear_comment_check_1", sql`length(comment_id) BETWEEN 1 AND 300`),
    check("linear_comment_check_2", sql`length(issue_id) BETWEEN 1 AND 300`),
    check("linear_comment_check_3", sql`source IN ('webhook','poll')`),
    check("linear_comment_check_4", sql`edited IN (0,1)`),
    check(
      "linear_comment_check_5",
      sql`state IN ('received','queued','delivered','answered','ignored','rejected','removed')`,
    ),
    check("linear_comment_check_6", sql`authority IS NULL OR authority IN ('person','agent')`),
    check(
      "linear_comment_check_7",
      sql`via IS NULL OR via IN ('brief','follow_up','restart','answer')`,
    ),
  ],
);
