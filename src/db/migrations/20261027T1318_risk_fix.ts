import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261027T1318_risk_fix",
  sql: `
CREATE TABLE risk_fix (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  head_sha TEXT NOT NULL,
  approved_head TEXT NOT NULL,
  approved_question_id TEXT NOT NULL,
  changed TEXT NOT NULL CHECK (json_valid(changed)),
  paths TEXT NOT NULL CHECK (json_valid(paths)),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, head_sha)
) STRICT;
`,
};
