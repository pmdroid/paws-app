import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261031T0627_restart_budget_grants",
  sql: `
CREATE TABLE restart_budget_grant (
  question_id TEXT PRIMARY KEY REFERENCES question(id),
  item_id TEXT NOT NULL REFERENCES work_item(id),
  restart_limit INTEGER NOT NULL CHECK (restart_limit > 0)
) STRICT;
CREATE INDEX restart_budget_grant_item ON restart_budget_grant(item_id);
`,
};
