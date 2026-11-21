import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

export const notebook = pgTable(
  "notebook",
  {
    workspaceId: text("workspace_id").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    revision: integer().notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.workspaceId, table.scopeKind, table.scopeId] }),
    check("notebook_scope_kind", sql`scope_kind IN ('repository', 'project')`),
  ],
);

export const notebookEntry = pgTable(
  "notebook_entry",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    body: text().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    index("notebook_entry_scope").on(table.workspaceId, table.scopeKind, table.scopeId, table.id),
  ],
);

export const notebookChange = pgTable(
  "notebook_change",
  {
    id: text().primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    entryId: text("entry_id").notNull(),
    action: text().notNull(),
    before: text(),
    after: text(),
    itemId: text("item_id"),
    actorId: text("actor_id"),
    at: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    check("notebook_change_action", sql`action IN ('add', 'patch', 'remove')`),
    index("notebook_change_scope").on(table.workspaceId, table.scopeKind, table.scopeId, table.id),
  ],
);
