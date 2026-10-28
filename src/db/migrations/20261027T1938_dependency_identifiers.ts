import type { Migration } from "../migration";

/** Linear identifiers of an item's blockers, read with their states, so a hold can name them. */
export const migration: Migration = {
  id: "20261027T1938_dependency_identifiers",
  sql: `
ALTER TABLE item_dependency_snapshot ADD COLUMN linear_identifiers TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(linear_identifiers));
`,
};
