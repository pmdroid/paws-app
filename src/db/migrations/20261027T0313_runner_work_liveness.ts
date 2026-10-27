import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261027T0313_runner_work_liveness",
  sql: `ALTER TABLE runner_work ADD COLUMN confirmed_at INTEGER;
ALTER TABLE runner_work ADD COLUMN lost_at INTEGER;`,
};
