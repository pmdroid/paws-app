import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261103T0156_pull_ci_failure",
  sql: `
CREATE TABLE pull_ci_failure (
  item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
  head TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  item_version INTEGER NOT NULL,
  failed_checks TEXT NOT NULL CHECK(json_valid(failed_checks)),
  checks TEXT NOT NULL CHECK(json_valid(checks)),
  observed_at INTEGER NOT NULL,
  handled_at INTEGER,
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('restarted','asked','dropped','cleared')),
  PRIMARY KEY (item_id, head)
) STRICT;
CREATE INDEX pull_ci_failure_pending ON pull_ci_failure(item_id) WHERE handled_at IS NULL;`,
};
