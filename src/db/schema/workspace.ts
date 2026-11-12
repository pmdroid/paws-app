import {
  check,
  foreignKey,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { linearSession } from "./linear";

export const workspace = sqliteTable(
  "workspace",
  {
    id: text().primaryKey().notNull(),
    linearOrganizationId: text("linear_organization_id").notNull(),
    name: text().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [unique().on(table.linearOrganizationId)],
);

export const workspaceUser = sqliteTable(
  "workspace_user",
  {
    id: text().primaryKey().notNull(),
    linearUserId: text("linear_user_id").notNull(),
    name: text().notNull(),
    email: text().notNull(),
  },
  (table) => [unique().on(table.linearUserId)],
);

export const workspaceMember = sqliteTable(
  "workspace_member",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    userId: text("user_id")
      .notNull()
      .references(() => workspaceUser.id),
    role: text().notNull(),
    source: text().notNull(),
    active: integer().notNull(),
    checkedAt: integer("checked_at").notNull(),
    manualRole: text("manual_role"),
    revokedAt: integer("revoked_at"),
    revokedBy: text("revoked_by").references(() => workspaceUser.id),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.userId],
      name: "workspace_member_workspace_id_user_id_pk",
    }),
    check("workspace_member_check_1", sql`role IN ('owner','admin','member','observer')`),
    check("workspace_member_check_2", sql`source IN ('linear','manual')`),
    check("workspace_member_check_3", sql`active IN (0,1)`),
    check("workspace_member_check_4", sql`manual_role IN ('owner','admin','member','observer')`),
  ],
);

export const workspaceUserTeam = sqliteTable(
  "workspace_user_team",
  {
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    teamId: text("team_id").notNull(),
  },
  (table) => [
    foreignKey(() => ({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
      name: "workspace_user_team_workspace_id_user_id_workspace_member_workspace_id_user_id_fk",
    })),
    primaryKey({
      columns: [table.workspaceId, table.userId, table.teamId],
      name: "workspace_user_team_workspace_id_user_id_team_id_pk",
    }),
  ],
);

export const workspaceRepository = sqliteTable(
  "workspace_repository",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    repository: text().notNull(),
    teamId: text("team_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.repository, table.teamId],
      name: "workspace_repository_workspace_id_repository_team_id_pk",
    }),
  ],
);

export const workspaceSession = sqliteTable("workspace_session", {
  tokenHash: text("token_hash").primaryKey().notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => workspaceUser.id),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id),
  csrfToken: text("csrf_token").notNull(),
  authenticatedAt: integer("authenticated_at").notNull(),
  lastSeenAt: integer("last_seen_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
});

export const workspaceBootstrap = sqliteTable("workspace_bootstrap", {
  tokenHash: text("token_hash").primaryKey().notNull(),
  organizationId: text("organization_id").notNull(),
  expiresAt: integer("expires_at").notNull(),
  consumedAt: integer("consumed_at"),
});

export const workspaceOauthRequest = sqliteTable("workspace_oauth_request", {
  stateHash: text("state_hash").primaryKey().notNull(),
  browserHash: text("browser_hash").notNull(),
  verifier: text().notNull(),
  bootstrapHash: text("bootstrap_hash"),
  expiresAt: integer("expires_at").notNull(),
  assignmentHash: text("assignment_hash"),
});

export const workspaceAccessAudit = sqliteTable("workspace_access_audit", {
  id: integer().primaryKey({ autoIncrement: true }),
  workspaceId: text("workspace_id").references(() => workspace.id),
  userId: text("user_id").references(() => workspaceUser.id),
  action: text().notNull(),
  subject: text().notNull(),
  createdAt: integer("created_at").notNull(),
});

export const workspaceAssignment = sqliteTable(
  "workspace_assignment",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => linearSession.sessionId),
    generation: integer().notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    actorId: text("actor_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    fingerprint: text().notNull(),
    event: text().notNull(),
    expiresAt: integer("expires_at").notNull(),
    status: text().notNull(),
    linkId: text("link_id"),
    linkExpiresAt: integer("link_expires_at"),
    completedAt: integer("completed_at"),
  },
  (table) => [
    primaryKey({
      columns: [table.sessionId, table.generation],
      name: "workspace_assignment_session_id_generation_pk",
    }),
    unique().on(table.tokenHash),
    uniqueIndex("workspace_assignment_link_id").on(table.linkId),
    check("workspace_assignment_check_1", sql`json_valid(event)`),
    check(
      "workspace_assignment_check_2",
      sql`status IN ('pending','ready','accepted','continued','invalid')`,
    ),
  ],
);

export const workspaceGithubConnection = sqliteTable("workspace_github_connection", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .notNull()
    .references(() => workspace.id),
  generation: integer().default(0).notNull(),
  secretId: text("secret_id"),
  actorId: text("actor_id").references(() => workspaceUser.id),
  installationId: text("installation_id"),
  repositories: text().default("[]").notNull(),
});

export const workspaceGithubOauth = sqliteTable(
  "workspace_github_oauth",
  {
    stateHash: text("state_hash").primaryKey().notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    userId: text("user_id")
      .notNull()
      .references(() => workspaceUser.id),
    sessionHash: text("session_hash").notNull(),
    secretId: text("secret_id").notNull(),
    expectedGeneration: integer("expected_generation").notNull(),
    intent: text().notNull(),
    expiresAt: integer("expires_at").notNull(),
    status: text().default("pending").notNull(),
  },
  () => [
    check(
      "workspace_github_oauth_check_1",
      sql`status IN ('pending','claimed','complete','failed')`,
    ),
  ],
);

export const verifiedGithubAttribution = sqliteTable(
  "verified_github_attribution",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    userId: text("user_id")
      .notNull()
      .references(() => workspaceUser.id),
    githubId: integer("github_id"),
    login: text(),
    name: text(),
    consentedAt: integer("consented_at"),
    revokedAt: integer("revoked_at"),
    revision: integer().default(0).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.userId],
      name: "verified_github_attribution_workspace_id_user_id_pk",
    }),
    uniqueIndex("verified_github_attribution_account")
      .on(table.workspaceId, table.githubId)
      .where(sql`consented_at IS NOT NULL AND revoked_at IS NULL`),
    check("verified_github_attribution_check_1", sql`github_id>0`),
  ],
);

export const githubAttributionRequest = sqliteTable(
  "github_attribution_request",
  {
    stateHash: text("state_hash").primaryKey().notNull(),
    browserHash: text("browser_hash").notNull(),
    sessionHash: text("session_hash")
      .notNull()
      .references(() => workspaceSession.tokenHash, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    userId: text("user_id")
      .notNull()
      .references(() => workspaceUser.id),
    revision: integer().notNull(),
    expiresAt: integer("expires_at").notNull(),
    returnPath: text("return_path"),
  },
  () => [
    check(
      "github_attribution_request_check_1",
      sql`return_path IS NULL OR return_path = '/status/settings/account' OR ( length(return_path) = 35 AND substr(return_path, 1, 9) = '/onboard/' AND substr(return_path, 10) NOT GLOB '*[^0-9A-Za-z]*' )`,
    ),
  ],
);
