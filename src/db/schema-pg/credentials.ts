import { bigint, check, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const credential = pgTable(
  "credential",
  {
    kind: text().notNull(),
    workspace: text().notNull(),
    ciphertext: text().notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.workspace], name: "credential_kind_workspace_pk" }),
    check("credential_kind", sql`kind IN ('linear', 'slack')`),
  ],
);
