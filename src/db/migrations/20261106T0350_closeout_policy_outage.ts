import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261106T0350_closeout_policy_outage",
  sql: `
CREATE TABLE closeout_policy_outage (
  repository TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  error TEXT NOT NULL,
  policy_path TEXT NOT NULL,
  main_sha TEXT NOT NULL,
  changed_by_sha TEXT,
  question_id TEXT,
  question_item_id TEXT
) STRICT;
`,
};
