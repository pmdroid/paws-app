import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261105T0332_stage_time",
  sql: `
ALTER TABLE work_item ADD COLUMN implement_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_item ADD COLUMN fix_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_item ADD COLUMN max_fix_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_item ADD COLUMN max_closeout_ms INTEGER NOT NULL DEFAULT 0;
UPDATE work_item SET implement_ms = agent_ms;
`,
};
