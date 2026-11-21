import { bigint, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { workspace } from "./workspace";

export const linearProjectTeam = pgTable(
  "linear_project_team",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id),
    projectId: text("project_id").notNull(),
    teamId: text("team_id").notNull(),
    seenAt: bigint("seen_at", { mode: "number" }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.workspaceId, table.projectId, table.teamId] })],
);
