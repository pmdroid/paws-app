export type Migration = {
  id: string;
  sql: string;
};

/**
 * Append-only. Shipped ids are never edited; add `002_*.sql` as the next entry.
 * Domain tables (epic, work item, run) arrive with the issue that first writes them.
 */
export const migrations: readonly Migration[] = [
  {
    id: "001_jobs_outbox",
    sql: `
CREATE TABLE job (
  id INTEGER PRIMARY KEY,
  queue TEXT NOT NULL,
  job_key TEXT UNIQUE,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  priority INTEGER NOT NULL DEFAULT 5,
  run_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'dead', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 10,
  locked_by TEXT,
  locked_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;
CREATE INDEX job_due ON job (status, run_at, priority);

CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  target TEXT NOT NULL CHECK (target IN ('linear', 'slack', 'github', 'sandbox')),
  op TEXT NOT NULL,
  ordering_key TEXT,
  critical INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  ephemeral INTEGER NOT NULL DEFAULT 0,
  priority INTEGER NOT NULL DEFAULT 5,
  not_before INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'dead', 'dropped')),
  external_id TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
) STRICT;
CREATE INDEX outbox_due ON outbox (status, target, not_before, priority);
`,
  },
];
