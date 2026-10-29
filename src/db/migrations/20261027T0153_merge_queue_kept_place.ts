import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261027T0153_merge_queue_kept_place",
  sql: `ALTER TABLE merge_queue_entry ADD COLUMN kept INTEGER NOT NULL DEFAULT 0 CHECK (kept IN (0, 1));`,
};
