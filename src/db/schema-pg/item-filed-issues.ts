import { bigint, boolean, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { workItem } from "./items";

export const itemFiledIssue = pgTable(
  "item_filed_issue",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    linearIssueId: text("linear_issue_id").notNull(),
    identifier: text().notNull(),
    title: text().notNull(),
    url: text(),
    started: boolean().notNull(),
    runId: text("run_id").notNull(),
    filedAt: bigint("filed_at", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.itemId, table.linearIssueId] })],
);
