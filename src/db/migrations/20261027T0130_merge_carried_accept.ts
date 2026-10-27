import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261027T0130_merge_carried_accept",
  sql: `
CREATE TABLE merge_carried_accept (
  item_id TEXT NOT NULL,
  head TEXT NOT NULL,
  accepted_head TEXT NOT NULL,
  base TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, head)
) STRICT;
`,
};
