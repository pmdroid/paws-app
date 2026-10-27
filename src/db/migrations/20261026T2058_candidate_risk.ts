import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261026T2058_candidate_risk",
  sql: `
CREATE TABLE candidate_risk (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  head_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('high', 'normal')),
  paths TEXT NOT NULL CHECK (json_valid(paths)),
  classified_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, head_sha)
) STRICT;
`,
};
