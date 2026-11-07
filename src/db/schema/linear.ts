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

export const linearSessionContext = sqliteTable("linear_session_context", {
  sessionId: text("session_id").primaryKey().notNull(),
  context: text().notNull(),
  richness: integer().notNull(),
  snapshotContext: text("snapshot_context"),
});

export const linearActivitySnapshot = sqliteTable(
  "linear_activity_snapshot",
  {
    id: text().primaryKey().notNull(),
    sessionId: text("session_id").notNull(),
    createdAt: text("created_at").notNull(),
    snapshot: text().notNull(),
  },
  (table) => [
    index("linear_activity_session").on(table.sessionId, table.createdAt, table.id),
    check("linear_activity_snapshot_check_1", sql`json_valid(snapshot)`),
  ],
);

export const linearSession = sqliteTable("linear_session", {
  sessionId: text("session_id").primaryKey().notNull(),
  issueId: text("issue_id"),
  organizationId: text("organization_id"),
  appUserId: text("app_user_id"),
  creatorId: text("creator_id"),
  activeItemId: text("active_item_id").references(() => workItem.id),
  generation: integer().default(0).notNull(),
  stoppedAt: integer("stopped_at"),
  createdAt: integer("created_at").notNull(),
  oauthClientId: text("oauth_client_id"),
  teamId: text("team_id"),
  installationObservedAt: integer("installation_observed_at"),
});

export const linearTurn = sqliteTable(
  "linear_turn",
  {
    ordinal: integer().primaryKey({ autoIncrement: true }),
    eventKey: text("event_key").notNull(),
    activityId: text("activity_id"),
    sessionId: text("session_id")
      .notNull()
      .references(() => linearSession.sessionId),
    actorId: text("actor_id"),
    body: text().notNull(),
    payload: text().notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    receivedAt: integer("received_at").notNull(),
    itemId: text("item_id").references(() => workItem.id),
    state: text().default("pending").notNull(),
    announcedGeneration: integer("announced_generation"),
  },
  (table) => [
    unique().on(table.eventKey),
    unique().on(table.activityId),
    index("linear_turn_pending").on(table.sessionId, table.state, table.createdAtMs, table.ordinal),
    check("linear_turn_check_1", sql`json_valid(payload)`),
    check("linear_turn_check_2", sql`state IN ('pending','applied','cancelled')`),
  ],
);

export const linearArtifact = sqliteTable(
  "linear_artifact",
  {
    id: text().primaryKey().notNull(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    runId: text("run_id").notNull(),
    path: text().notNull(),
    displayName: text("display_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text().notNull(),
    requestVersion: integer("request_version").default(0).notNull(),
    state: text().notNull(),
    assetUrl: text("asset_url"),
    createdAt: integer("created_at").notNull(),
    identityHash: text("identity_hash"),
  },
  (table) => [
    unique().on(table.itemId, table.path, table.displayName, table.mimeType, table.sha256),
    check("linear_artifact_check_1", sql`state IN ('pending', 'uploaded', 'failed')`),
  ],
);

export const linearInput = sqliteTable(
  "linear_input",
  {
    sessionId: text("session_id").notNull(),
    turnId: text("turn_id").notNull(),
    assetId: text("asset_id").notNull(),
    assetUrl: text("asset_url").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer().notNull(),
    sha256: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.sessionId, table.turnId, table.assetId],
      name: "linear_input_session_id_turn_id_asset_id_pk",
    }),
  ],
);

export const linearConversation = sqliteTable(
  "linear_conversation",
  {
    itemId: text("item_id")
      .primaryKey()
      .notNull()
      .references(() => workItem.id),
    entries: text().notNull(),
    transcript: text(),
    transcriptOffset: integer("transcript_offset").default(0).notNull(),
    blocked: integer().default(0).notNull(),
    blockedAt: integer("blocked_at"),
  },
  () => [
    check("linear_conversation_check_1", sql`json_valid(entries)`),
    check("linear_conversation_check_2", sql`blocked IN (0,1)`),
  ],
);

export const linearStopReceipt = sqliteTable(
  "linear_stop_receipt",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => linearSession.sessionId),
    eventKey: text("event_key").notNull(),
    generation: integer().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.sessionId, table.eventKey],
      name: "linear_stop_receipt_session_id_event_key_pk",
    }),
  ],
);

export const linearSessionCleanupBlock = sqliteTable("linear_session_cleanup_block", {
  sessionId: text("session_id")
    .primaryKey()
    .notNull()
    .references(() => linearSession.sessionId),
});

export const linearArtifactAttempt = sqliteTable(
  "linear_artifact_attempt",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    identityHash: text("identity_hash").notNull(),
    version: integer().notNull(),
    completedVersion: integer("completed_version").default(0).notNull(),
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

export const linearAppRevocation = sqliteTable(
  "linear_app_revocation",
  {
    organizationId: text("organization_id").notNull(),
    oauthClientId: text("oauth_client_id").notNull(),
    revokedAt: integer("revoked_at").notNull(),
    generation: integer().default(1).notNull(),
    restoredAfter: integer("restored_after"),
    restoredCredentialFingerprint: text("restored_credential_fingerprint"),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.oauthClientId],
      name: "linear_app_revocation_organization_id_oauth_client_id_pk",
    }),
  ],
);

export const linearTeamAccess = sqliteTable(
  "linear_team_access",
  {
    organizationId: text("organization_id").notNull(),
    oauthClientId: text("oauth_client_id").notNull(),
    appUserId: text("app_user_id").notNull(),
    teamId: text("team_id").notNull(),
    allowed: integer().notNull(),
    observedAt: integer("observed_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.oauthClientId, table.appUserId, table.teamId],
      name: "linear_team_access_organization_id_oauth_client_id_app_user_id_team_id_pk",
    }),
    check("linear_team_access_check_1", sql`allowed IN (0, 1)`),
  ],
);

export const linearInstallationPermission = sqliteTable(
  "linear_installation_permission",
  {
    organizationId: text("organization_id").notNull(),
    oauthClientId: text("oauth_client_id").notNull(),
    appUserId: text("app_user_id").notNull(),
    allPublicTeams: integer("all_public_teams").notNull(),
    observedAt: integer("observed_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.organizationId, table.oauthClientId, table.appUserId],
      name: "linear_installation_permission_organization_id_oauth_client_id_app_user_id_pk",
    }),
    check("linear_installation_permission_check_1", sql`all_public_teams IN (0, 1)`),
  ],
);

export const linearAccessEvent = sqliteTable("linear_access_event", {
  eventKey: text("event_key").primaryKey().notNull(),
  createdAt: integer("created_at").notNull(),
});

export const linearTaskDelegation = sqliteTable(
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

export const linearIssueContext = sqliteTable(
  "linear_issue_context",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => linearSession.sessionId),
    issueId: text("issue_id").notNull(),
    observedAt: integer("observed_at").notNull(),
    context: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.sessionId, table.issueId],
      name: "linear_issue_context_session_id_issue_id_pk",
    }),
  ],
);

export const linearOutboxBackoff = sqliteTable(
  "linear_outbox_backoff",
  {
    id: integer().primaryKey(),
    notBefore: integer("not_before").notNull(),
  },
  () => [check("linear_outbox_backoff_check_1", sql`id=1`)],
);

export const linearActivityListing = sqliteTable("linear_activity_listing", {
  sessionId: text("session_id").primaryKey().notNull(),
  generation: integer().notNull(),
});

export const linearItemRequest = sqliteTable("linear_item_request", {
  itemId: text("item_id").primaryKey().notNull(),
  requests: integer().notNull(),
});

export const linearItemCallerRequest = sqliteTable(
  "linear_item_caller_request",
  {
    itemId: text("item_id").notNull(),
    caller: text().notNull(),
    requests: integer().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.itemId, table.caller],
      name: "linear_item_caller_request_item_id_caller_pk",
    }),
  ],
);

export const linearComment = sqliteTable(
  "linear_comment",
  {
    commentId: text("comment_id").primaryKey().notNull(),
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
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    receivedAt: integer("received_at").notNull(),
    source: text().notNull(),
    edited: integer().default(0).notNull(),
    removedAt: integer("removed_at"),
    state: text().default("received").notNull(),
    reason: text(),
    authority: text(),
    itemId: text("item_id"),
    sessionId: text("session_id"),
    generation: integer(),
    itemVersion: integer("item_version"),
    via: text(),
    settledAt: integer("settled_at"),
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
