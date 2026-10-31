import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261031T2228_system_fault",
  sql: `CREATE TABLE system_fault (
    item_id TEXT PRIMARY KEY REFERENCES work_item(id) ON DELETE CASCADE,
    item_version INTEGER NOT NULL,
    fault_class TEXT NOT NULL,
    reason TEXT NOT NULL,
    failures INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    retry_at INTEGER NOT NULL
  ) STRICT;`,
};
