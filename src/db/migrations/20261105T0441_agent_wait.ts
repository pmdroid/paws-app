import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261105T0441_agent_wait",
  sql: `
CREATE TABLE agent_wait (
  run_id TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  waiting_ms INTEGER NOT NULL
) STRICT;
`,
};
