import { bigint, boolean, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";

export const storageSnapshot = pgTable(
  "storage_snapshot",
  {
    id: text().primaryKey(),
    machine: text().notNull(),
    takenAt: bigint("taken_at", { mode: "number" }).notNull(),
    partial: boolean().notNull(),
    filesystems: jsonb().notNull(),
    categories: jsonb().notNull(),
  },
  (table) => [index("storage_snapshot_machine_taken_at").on(table.machine, table.takenAt)],
);
