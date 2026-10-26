import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261026T2210_closeout_bypass_check",
  sql: `
CREATE TABLE closeout_bypass_check (
  question_id TEXT NOT NULL REFERENCES question(id),
  check_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER,
  message TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  reason TEXT,
  approved_by TEXT,
  approved_by_name TEXT,
  approved_at INTEGER,
  PRIMARY KEY (question_id, check_id)
) STRICT;
`,
};
