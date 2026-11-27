import { bigint, index, pgTable, text } from "drizzle-orm/pg-core";
import { workItem } from "./items";
import { jsonb } from "./types";

export const issueSplit = pgTable(
  "issue_split",
  {
    id: text().primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    workspaceId: text("workspace_id"),
    parentIssueId: text("parent_issue_id").notNull(),
    parentIdentifier: text("parent_identifier").notNull(),
    repository: text(),
    drafts: jsonb().notNull(),
    questionId: text("question_id"),
    status: text().notNull(),
    decidedBy: text("decided_by"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    filedAt: bigint("filed_at", { mode: "number" }),
    closedAt: bigint("closed_at", { mode: "number" }),
  },
  (table) => [
    index("issue_split_workspace").on(table.workspaceId, table.status),
    index("issue_split_question").on(table.questionId),
  ],
);

export const issueSplitPart = pgTable(
  "issue_split_part",
  {
    issueId: text("issue_id").primaryKey(),
    splitId: text("split_id")
      .notNull()
      .references(() => issueSplit.id),
    identifier: text().notNull(),
    url: text(),
    position: bigint({ mode: "number" }).notNull(),
    mergedAt: bigint("merged_at", { mode: "number" }),
  },
  (table) => [index("issue_split_part_split").on(table.splitId)],
);
