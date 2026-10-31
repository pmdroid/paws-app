import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261029T2000_finding_grouping_switch",
  sql: `CREATE TABLE finding_grouping_off (
 workspace_id TEXT PRIMARY KEY REFERENCES workspace(id)
) STRICT;`,
};
