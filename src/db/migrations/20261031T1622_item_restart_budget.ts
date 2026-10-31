import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261031T1622_item_restart_budget",
  sql: `
ALTER TABLE work_item ADD COLUMN restart_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_item ADD COLUMN restart_limit INTEGER NOT NULL DEFAULT 10;
`,
};
