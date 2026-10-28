import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261028T0724_merge_call",
  sql: `
CREATE TABLE merge_call (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  head_sha TEXT NOT NULL,
  started_at INTEGER NOT NULL
) STRICT;
`,
};
