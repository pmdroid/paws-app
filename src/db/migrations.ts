export type Migration = {
  id: string;
  sql: string;
};

/**
 * Append-only. Shipped ids are never edited; add the next numbered migration.
 * Epic and work item landed in 002. Recovery columns, runs, and wake rows are 003.
 * Open questions for ask_team are 004.
 * GitHub issue poll cursors and ETags are 005.
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
  {
    id: "003_recovery_host",
    sql: `
ALTER TABLE job ADD COLUMN recurring_every_ms INTEGER;
ALTER TABLE job ADD COLUMN fire_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job ADD COLUMN lane TEXT NOT NULL DEFAULT 'default';

ALTER TABLE outbox ADD COLUMN locked_by TEXT;
ALTER TABLE outbox ADD COLUMN locked_until INTEGER;
ALTER TABLE outbox ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 5;

ALTER TABLE work_item ADD COLUMN checkpoint TEXT CHECK (checkpoint IS NULL OR json_valid(checkpoint));
ALTER TABLE work_item ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_item ADD COLUMN awake_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_item ADD COLUMN last_mono_ms INTEGER;
ALTER TABLE work_item ADD COLUMN turn_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_item ADD COLUMN max_turns INTEGER NOT NULL DEFAULT 80;
ALTER TABLE work_item ADD COLUMN max_awake_ms INTEGER NOT NULL DEFAULT 2700000;
ALTER TABLE work_item ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0;
ALTER TABLE work_item ADD COLUMN session_key TEXT;
ALTER TABLE work_item ADD COLUMN current_run_id TEXT;

CREATE TABLE run (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES work_item (id),
  kind TEXT NOT NULL,
  agent TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('provisioning', 'active', 'ended', 'lost')),
  checkpoint TEXT CHECK (checkpoint IS NULL OR json_valid(checkpoint)),
  fresh_session INTEGER NOT NULL DEFAULT 0 CHECK (fresh_session IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX run_item ON run (item_id, created_at);

CREATE TABLE wake (
  from_wall INTEGER PRIMARY KEY,
  to_wall INTEGER NOT NULL,
  slept_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
`,
  },
  {
    id: "004_questions",
    sql: `
CREATE TABLE question (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  run_id TEXT,
  session_id TEXT NOT NULL,
  body TEXT NOT NULL,
  options TEXT CHECK (options IS NULL OR json_valid(options)),
  status TEXT NOT NULL CHECK (status IN ('open', 'answered')),
  answer TEXT,
  answered_by TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
) STRICT;
CREATE INDEX question_session_open ON question (session_id, status);
`,
  },
  {
    id: "005_github_poll",
    sql: `
CREATE TABLE github_poll_state (
  repo TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('issues', 'comments')),
  cursor_ms INTEGER NOT NULL,
  etag TEXT,
  url TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (repo, kind)
) STRICT;

CREATE TABLE github_seen (
  dedupe_key TEXT PRIMARY KEY,
  seen_at INTEGER NOT NULL
) STRICT;

CREATE TABLE github_label_state (
  issue_key TEXT PRIMARY KEY,
  labeled INTEGER NOT NULL CHECK (labeled IN (0, 1)),
  updated_at INTEGER NOT NULL
) STRICT;
`,
  },
  {
    id: "006_work_brief",
    sql: `
ALTER TABLE work_item ADD COLUMN brief TEXT CHECK (brief IS NULL OR json_valid(brief));
`,
  },
  {
    id: "007_closeout_progress",
    sql: `
CREATE TABLE closeout_progress (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  base TEXT NOT NULL,
  head TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  policy_path TEXT,
  decision TEXT,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER
) STRICT;
CREATE INDEX closeout_progress_item ON closeout_progress (item_id, updated_at);

CREATE TABLE closeout_step (
  progress_id TEXT NOT NULL REFERENCES closeout_progress (id),
  step_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('setup', 'command', 'review')),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'running', 'passed', 'failed', 'blocked', 'skipped', 'exhausted'
  )),
  command TEXT NOT NULL,
  detail TEXT,
  attempt INTEGER NOT NULL,
  timeout_seconds INTEGER,
  started_at INTEGER,
  finished_at INTEGER,
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0 CHECK (timed_out IN (0, 1)),
  timeout_reason TEXT,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
  log_path TEXT,
  evidence_path TEXT,
  findings TEXT,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY (progress_id, step_id)
) STRICT;
`,
  },
];
