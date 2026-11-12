import {
  bigint,
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { jsonb } from "./types";
import { sql } from "drizzle-orm";
import { linearSession } from "./linear";

export const workspace = pgTable(
  "workspace",
  {
    id: text().primaryKey(),
    linearOrganizationId: text("linear_organization_id").notNull(),
    name: text().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [unique().on(table.linearOrganizationId)],
);

export const workspaceUser = pgTable(
  "workspace_user",
  {
    id: text().primaryKey(),
    linearUserId: text("linear_user_id").notNull(),
    name: text().notNull(),
    email: text().notNull(),
  },
  (table) => [unique().on(table.linearUserId)],
);

export const workspaceMember = pgTable(
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
    checkedAt: bigint("checked_at", { mode: "number" }).notNull(),
    manualRole: text("manual_role"),
    revokedAt: bigint("revoked_at", { mode: "number" }),
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

export const workspaceUserTeam = pgTable(
  "workspace_user_team",
  {
    workspaceId: text("workspace_id").notNull(),
    userId: text("user_id").notNull(),
    teamId: text("team_id").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.userId, table.teamId],
      name: "workspace_user_team_workspace_id_user_id_team_id_pk",
    }),
    foreignKey({
      columns: [table.workspaceId, table.userId],
      foreignColumns: [workspaceMember.workspaceId, workspaceMember.userId],
      name: "workspace_user_team_workspace_id_user_id_workspace_member_workspace_id_user_id_fk",
    }),
  ],
);

export const workspaceRepository = pgTable(
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

export const workspaceSession = pgTable("workspace_session", {
  tokenHash: text("token_hash").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => workspaceUser.id),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspace.id),
  csrfToken: text("csrf_token").notNull(),
  authenticatedAt: bigint("authenticated_at", { mode: "number" }).notNull(),
  lastSeenAt: bigint("last_seen_at", { mode: "number" }).notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
});

export const workspaceBootstrap = pgTable("workspace_bootstrap", {
  tokenHash: text("token_hash").primaryKey(),
  organizationId: text("organization_id").notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  consumedAt: bigint("consumed_at", { mode: "number" }),
});

export const workspaceOauthRequest = pgTable("workspace_oauth_request", {
  stateHash: text("state_hash").primaryKey(),
  browserHash: text("browser_hash").notNull(),
  verifier: text().notNull(),
  bootstrapHash: text("bootstrap_hash"),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  assignmentHash: text("assignment_hash"),
});

export const workspaceAccessAudit = pgTable("workspace_access_audit", {
  id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  workspaceId: text("workspace_id").references(() => workspace.id),
  userId: text("user_id").references(() => workspaceUser.id),
  action: text().notNull(),
  subject: text().notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const workspaceAssignment = pgTable(
  "workspace_assignment",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => linearSession.sessionId),
    generation: bigint({ mode: "number" }).notNull(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    actorId: text("actor_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    fingerprint: text().notNull(),
    event: jsonb().notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    status: text().notNull(),
    linkId: text("link_id"),
    linkExpiresAt: bigint("link_expires_at", { mode: "number" }),
    completedAt: bigint("completed_at", { mode: "number" }),
  },
  (table) => [
    primaryKey({
      columns: [table.sessionId, table.generation],
      name: "workspace_assignment_session_id_generation_pk",
    }),
    unique().on(table.tokenHash),
    uniqueIndex("workspace_assignment_link_id").on(table.linkId),
    check(
      "workspace_assignment_check_2",
      sql`status IN ('pending','ready','accepted','continued','invalid')`,
    ),
  ],
);

export const workspaceGithubConnection = pgTable("workspace_github_connection", {
  workspaceId: text("workspace_id")
    .primaryKey()
    .references(() => workspace.id),
  generation: bigint({ mode: "number" }).default(0).notNull(),
  secretId: text("secret_id"),
  actorId: text("actor_id").references(() => workspaceUser.id),
  installationId: text("installation_id"),
  repositories: text().default("[]").notNull(),
});

export const workspaceGithubOauth = pgTable(
  "workspace_github_oauth",
  {
    stateHash: text("state_hash").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    userId: text("user_id")
      .notNull()
      .references(() => workspaceUser.id),
    sessionHash: text("session_hash").notNull(),
    secretId: text("secret_id").notNull(),
    expectedGeneration: bigint("expected_generation", { mode: "number" }).notNull(),
    intent: text().notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    status: text().default("pending").notNull(),
  },
  () => [
    check(
      "workspace_github_oauth_check_1",
      sql`status IN ('pending','claimed','complete','failed')`,
    ),
  ],
);

export const verifiedGithubAttribution = pgTable(
  "verified_github_attribution",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    userId: text("user_id")
      .notNull()
      .references(() => workspaceUser.id),
    githubId: bigint("github_id", { mode: "number" }),
    login: text(),
    name: text(),
    consentedAt: bigint("consented_at", { mode: "number" }),
    revokedAt: bigint("revoked_at", { mode: "number" }),
    revision: bigint({ mode: "number" }).default(0).notNull(),
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

export const githubAttributionRequest = pgTable(
  "github_attribution_request",
  {
    stateHash: text("state_hash").primaryKey(),
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
    revision: bigint({ mode: "number" }).notNull(),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    returnPath: text("return_path"),
  },
  () => [
    check(
      "github_attribution_request_check_1",
      sql`return_path IS NULL OR return_path = '/status/settings/account' OR ( length(return_path) = 35 AND substr(return_path, 1, 9) = '/onboard/' AND substr(return_path, 10) !~ '[^0-9A-Za-z]' )`,
    ),
  ],
);
