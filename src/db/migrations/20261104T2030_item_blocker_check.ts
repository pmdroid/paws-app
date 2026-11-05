import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261104T2030_item_blocker_check",
  sql: `
CREATE TABLE item_blocker_check (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL
) STRICT;
`,
};
