import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261031T0644_restart_budget_handoffs",
  sql: `
CREATE TABLE restart_budget_handoff (
  id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  digest TEXT NOT NULL,
  handoff TEXT NOT NULL CHECK (json_valid(handoff)),
  queue_repository TEXT,
  queue_ready_at INTEGER,
  carried_version INTEGER,
  UNIQUE (item_id, digest)
) STRICT;
`,
};
