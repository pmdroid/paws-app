import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261028T0344_open_findings",
  sql: `
CREATE TABLE open_findings (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  head_sha TEXT NOT NULL,
  line TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
) STRICT;
`,
};
