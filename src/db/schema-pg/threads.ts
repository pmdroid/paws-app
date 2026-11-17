import { bigint, check, index, pgTable, text, unique, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace, workspaceUser } from "./workspace";

export const threadTask = pgTable(
  "thread_task",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    surface: text().notNull(),
    installationId: text("installation_id").notNull(),
    privateMember: text("private_member").notNull().default(""),
    primaryContextId: text("primary_context_id").notNull(),
    createdBy: text("created_by").notNull(),
    createdByUserId: text("created_by_user_id").references(() => workspaceUser.id),
    repository: text(),
    sourceRef: text("source_ref"),
    sourceCommit: text("source_commit"),
    sourceSetBy: text("source_set_by"),
    linearIssueId: text("linear_issue_id"),
    issueAttachedAt: bigint("issue_attached_at", { mode: "number" }),
    delegationId: text("delegation_id"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    uniqueIndex("thread_task_issue")
      .on(table.workspaceId, table.linearIssueId)
      .where(sql`linear_issue_id IS NOT NULL`),
    check("thread_task_surface", sql`surface IN ('slack', 'buzz')`),
  ],
);

export const threadContext = pgTable(
  "thread_context",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    surface: text().notNull(),
    installationId: text("installation_id").notNull(),
    kind: text().notNull(),
    channelId: text("channel_id").notNull(),
    threadId: text("thread_id").notNull().default(""),
    privateMember: text("private_member").notNull().default(""),
    taskId: text("task_id")
      .notNull()
      .references(() => threadTask.id),
    actor: text().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    unique("thread_context_key").on(
      table.workspaceId,
      table.surface,
      table.installationId,
      table.channelId,
      table.threadId,
      table.privateMember,
    ),
    index("thread_context_task").on(table.taskId),
    check("thread_context_surface", sql`surface IN ('slack', 'buzz')`),
    check("thread_context_kind", sql`kind IN ('thread', 'private', 'code_channel', 'project_hub')`),
    check("thread_context_private", sql`(kind = 'private') = (private_member <> '')`),
  ],
);
