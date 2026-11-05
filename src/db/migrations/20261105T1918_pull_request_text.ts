import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261105T1918_pull_request_text",
  sql: `
CREATE TABLE pull_request_text (
  item_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  evidence TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`,
};
