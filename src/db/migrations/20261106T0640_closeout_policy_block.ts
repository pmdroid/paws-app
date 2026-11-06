import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261106T0640_closeout_policy_block",
  sql: `
CREATE TABLE closeout_policy_block (
  question_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  cause TEXT NOT NULL CHECK (cause = 'policy_unreadable'),
  error TEXT NOT NULL,
  policy_path TEXT NOT NULL,
  main_sha TEXT NOT NULL,
  changed_by_sha TEXT,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX closeout_policy_block_repository ON closeout_policy_block(repository);
`,
};
