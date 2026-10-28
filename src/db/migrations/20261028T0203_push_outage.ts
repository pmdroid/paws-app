import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261028T0203_push_outage",
  sql: `
CREATE TABLE push_outage (
  repository TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  last_failed_at INTEGER NOT NULL,
  failed_probes INTEGER NOT NULL DEFAULT 0,
  next_probe_at INTEGER NOT NULL,
  probe_job_id INTEGER,
  installation_url TEXT,
  question_id TEXT
) STRICT;
`,
};
