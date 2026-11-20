import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, unique } from "drizzle-orm/pg-core";
import { jsonb } from "./types";
import { workItem } from "./items";

export const slackConversation = pgTable(
  "slack_conversation",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    teamId: text("team_id").notNull(),
    appId: text("app_id"),
    installGeneration: bigint("install_generation", { mode: "number" }).notNull(),
    channelId: text("channel_id").notNull(),
    threadTs: text("thread_ts").notNull(),
    startedBySlackUserId: text("started_by_slack_user_id").notNull(),
    startedEventId: text("started_event_id").notNull(),
    replyChannelId: text("reply_channel_id").notNull(),
    replyThreadTs: text("reply_thread_ts").notNull(),
    workItemId: text("work_item_id").references(() => workItem.id),
    issueId: text("issue_id"),
    stoppedTs: text("stopped_ts"),
    stoppedBySlackUserId: text("stopped_by_slack_user_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("slack_conversation_thread").on(
      table.workspaceId,
      table.teamId,
      table.channelId,
      table.threadTs,
      table.installGeneration,
    ),
  ],
);

export const slackThreadNote = pgTable(
  "slack_thread_note",
  {
    id: text().primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => slackConversation.id),
    workspaceId: text("workspace_id").notNull(),
    requestId: text("request_id").notNull(),
    authorUserId: text("author_user_id").notNull(),
    kind: text().notNull(),
    text: text().notNull(),
    repository: text(),
    path: text(),
    symbol: text(),
    commit: text(),
    sources: jsonb().notNull(),
    linearTeamIds: jsonb("linear_team_ids").notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    check("slack_thread_note_kind", sql`kind IN ('observation', 'guess', 'decision')`),
    index("slack_thread_note_conversation").on(table.conversationId, table.createdAt),
  ],
);
