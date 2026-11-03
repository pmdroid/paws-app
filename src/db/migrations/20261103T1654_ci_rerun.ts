import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261103T1654_ci_rerun",
  sql: `CREATE TABLE ci_rerun (
  item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
  head_sha TEXT NOT NULL,
  run_ids TEXT NOT NULL CHECK(json_valid(run_ids)),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
  at INTEGER NOT NULL,
  PRIMARY KEY (item_id, head_sha)
) STRICT;`,
};
