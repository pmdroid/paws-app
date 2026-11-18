import { bigint, check, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace, workspaceUser } from "./workspace";

export const workspaceSlackInstallation = pgTable(
  "workspace_slack_installation",
  {
    workspaceId: text("workspace_id")
      .primaryKey()
      .references(() => workspace.id),
    generation: bigint({ mode: "number" }).default(0).notNull(),
    status: text().default("none").notNull(),
    teamId: text("team_id"),
    teamName: text("team_name"),
    appId: text("app_id"),
    botUserId: text("bot_user_id"),
    scope: text().default("").notNull(),
    source: text(),
    actorId: text("actor_id").references(() => workspaceUser.id),
    updatedAt: bigint("updated_at", { mode: "number" }).default(0).notNull(),
  },
  (table) => [
    uniqueIndex("workspace_slack_installation_active_team")
      .on(table.teamId)
      .where(sql`status = 'active'`),
    check(
      "workspace_slack_installation_status",
      sql`status IN ('none','active','disconnected','revoked')`,
    ),
    check("workspace_slack_installation_source", sql`source IS NULL OR source IN ('oauth','cli')`),
  ],
);

export const workspaceSlackOauth = pgTable(
  "workspace_slack_oauth",
  {
    stateHash: text("state_hash").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    userId: text("user_id")
      .notNull()
      .references(() => workspaceUser.id),
    sessionHash: text("session_hash").notNull(),
    intent: text().notNull(),
    expectedGeneration: bigint("expected_generation", { mode: "number" }).notNull(),
    returnTeamId: text("return_team_id"),
    returnChannelId: text("return_channel_id"),
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    status: text().default("pending").notNull(),
  },
  () => [
    check("workspace_slack_oauth_intent", sql`intent IN ('install','reconnect','replace')`),
    check("workspace_slack_oauth_status", sql`status IN ('pending','claimed','complete','failed')`),
  ],
);
