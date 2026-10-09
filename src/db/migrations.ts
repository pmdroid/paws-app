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
  {
    id: "002_inbox_intake",
    sql: `
CREATE TABLE inbox_event (
  dedupe_key TEXT PRIMARY KEY,
  delivery_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('webhook', 'poll')),
  action TEXT NOT NULL CHECK (action IN ('created', 'prompted', 'other')),
  session_id TEXT,
  issue_id TEXT,
  activity_id TEXT,
  body TEXT,
  signal TEXT,
  updated_at_ms INTEGER NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  received_at INTEGER NOT NULL,
  handled INTEGER NOT NULL DEFAULT 0 CHECK (handled IN (0, 1))
) STRICT;
CREATE UNIQUE INDEX inbox_event_delivery ON inbox_event (delivery_id) WHERE delivery_id IS NOT NULL;
CREATE INDEX inbox_event_unhandled ON inbox_event (handled, received_at);

CREATE TABLE sync_cursor (
  name TEXT PRIMARY KEY,
  cursor_ms INTEGER NOT NULL
) STRICT;

CREATE TABLE epic (
  id TEXT PRIMARY KEY,
  linear_issue_id TEXT NOT NULL UNIQUE,
  linear_identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'planning',
    'awaiting_plan_approval',
    'running',
    'stalled',
    'done',
    'cancelled'
  )),
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE work_item (
  id TEXT PRIMARY KEY,
  epic_id TEXT NOT NULL REFERENCES epic (id),
  linear_issue_id TEXT NOT NULL UNIQUE,
  linear_identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'planning',
    'queued',
    'running',
    'paused',
    'awaiting_input',
    'recovering',
    'verifying',
    'exhausted',
    'failed',
    'awaiting_signoff',
    'merge_queue',
    'manual',
    'merged',
    'cancelled'
  )),
  branch_name TEXT NOT NULL,
  position INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX work_item_epic_position ON work_item (epic_id, position);

CREATE TABLE work_item_block (
  epic_id TEXT NOT NULL REFERENCES epic (id),
  blocker_linear_issue_id TEXT NOT NULL,
  blocked_linear_issue_id TEXT NOT NULL,
  PRIMARY KEY (epic_id, blocker_linear_issue_id, blocked_linear_issue_id)
) STRICT;
`,
  },
];
