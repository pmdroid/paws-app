import type { Migration } from "../migration";

/** The lane in the repository's merge queue: a Linear project id, or `''` for the whole repository. */
export const migration: Migration = {
  id: "20261105T0324_merge_queue_lane",
  sql: `
ALTER TABLE merge_queue_entry ADD COLUMN lane TEXT NOT NULL DEFAULT '';
CREATE INDEX merge_queue_entry_lane ON merge_queue_entry(repository, lane, ready_at, id);
`,
};
