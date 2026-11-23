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

export const storageCleanup = pgTable(
  "storage_cleanup",
  {
    id: text().primaryKey(),
    machine: text().notNull(),
    actor: text().notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    finishedAt: bigint("finished_at", { mode: "number" }),
    categories: jsonb().notNull(),
    deleted: jsonb().notNull(),
    skipped: jsonb().notNull(),
    freedBytes: bigint("freed_bytes", { mode: "number" }).notNull(),
    error: text(),
  },
  (table) => [index("storage_cleanup_machine_started_at").on(table.machine, table.startedAt)],
);

export const storageCleanupPreview = pgTable("storage_cleanup_preview", {
  id: text().primaryKey(),
  machine: text().notNull(),
  categories: jsonb().notNull(),
  items: jsonb().notNull(),
  kept: jsonb().notNull(),
  expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
  pending: boolean().notNull().default(false),
  actor: text(),
});
