import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261101T1430_runner_teardown",
  sql: `ALTER TABLE runner_work ADD COLUMN teardown_confirmed_at INTEGER;
    ALTER TABLE runner ADD COLUMN terminations_since INTEGER;
    UPDATE runner_work SET teardown_confirmed_at=ended_at WHERE ended_at IS NOT NULL
      AND EXISTS(SELECT 1 FROM runner_result r WHERE r.run_id=runner_work.run_id
        AND r.generation=runner_work.generation AND r.command_id=runner_work.command_id);`,
};
