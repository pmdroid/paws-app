import { check, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const credential = sqliteTable(
  "credential",
  {
    kind: text().notNull(),
    workspace: text().notNull(),
    ciphertext: text().notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.workspace] }),
    check("credential_kind", sql`kind IN ('linear', 'slack')`),
  ],
);
