import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261028T1904_finding_group_progress",
  sql: `
ALTER TABLE finding_group_run ADD COLUMN finding_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE finding_group_run ADD COLUMN issue_cursor INTEGER NOT NULL DEFAULT 0;
ALTER TABLE finding_group_run ADD COLUMN skip_reason TEXT;
`,
};
