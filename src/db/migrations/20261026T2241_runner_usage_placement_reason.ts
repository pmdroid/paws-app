import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261026T2241_runner_usage_placement_reason",
  sql: `ALTER TABLE runner_execution_usage ADD COLUMN placement_reason TEXT CHECK (placement_reason IS NULL OR placement_reason IN ('session_restore'));`,
};
