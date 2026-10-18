export type Migration = {
  id: string;
  sql: string;
  foreignKeys?: false;
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
  {
    id: "008_closeout_recovery",
    sql: `
CREATE TABLE closeout_recovery (
  question_id TEXT PRIMARY KEY REFERENCES question(id),
  task_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  base TEXT NOT NULL,
  head TEXT NOT NULL,
  policy_digest TEXT NOT NULL,
  failed_checks TEXT NOT NULL CHECK (json_valid(failed_checks)),
  retry_baseline TEXT NOT NULL CHECK (json_valid(retry_baseline)),
  summary TEXT NOT NULL
) STRICT;
CREATE INDEX closeout_recovery_item ON closeout_recovery (item_id);
`,
  },
  {
    id: "009_outbox_fences",
    sql: `
ALTER TABLE outbox ADD COLUMN delivery_kind TEXT NOT NULL DEFAULT 'ordered'
  CHECK (delivery_kind IN ('ordered', 'progress', 'critical', 'terminal', 'stop', 'status'));
ALTER TABLE outbox ADD COLUMN delivery_generation INTEGER NOT NULL DEFAULT 0;
UPDATE outbox SET delivery_kind = CASE
  WHEN op = 'elicitation' THEN 'critical'
  WHEN op = 'status' AND json_extract(payload, '$.stateType') = 'completed' THEN 'status'
  WHEN op = 'status' THEN 'progress'
  WHEN op IN ('activity', 'linear.activity') AND json_extract(payload, '$.kind') IN ('response', 'error') THEN 'terminal'
  WHEN op IN ('activity', 'linear.activity') THEN 'progress'
  ELSE 'ordered' END;
CREATE TABLE outbox_session_fence (
  target TEXT NOT NULL,
  ordering_key TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  stopped INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (target, ordering_key)
) STRICT;
CREATE INDEX outbox_session_delivery ON outbox (target, ordering_key, delivery_generation, status);
`,
  },
  {
    id: "010_github_deliveries",
    sql: `
CREATE TABLE github_delivery (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL
) STRICT;
`,
  },
  {
    id: "011_linear_session_context",
    sql: `
CREATE TABLE linear_session_context (
  session_id TEXT PRIMARY KEY,
  context TEXT NOT NULL,
  richness INTEGER NOT NULL,
  snapshot_context TEXT
) STRICT;
CREATE TABLE linear_activity_snapshot (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot))
) STRICT;
CREATE INDEX linear_activity_session ON linear_activity_snapshot (session_id, created_at, id);
`,
  },
  {
    id: "012_linear_task_identity",
    foreignKeys: false,
    sql: `
CREATE TABLE epic_task_identity (
  id TEXT PRIMARY KEY,
  linear_issue_id TEXT NOT NULL,
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
  task_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
) STRICT;
INSERT INTO epic_task_identity SELECT id,linear_issue_id,linear_identifier,title,state,version,'initial:' || linear_issue_id,created_at FROM epic;
DROP TABLE epic;
ALTER TABLE epic_task_identity RENAME TO epic;
CREATE TABLE work_item_task_identity (
  id TEXT PRIMARY KEY,
  epic_id TEXT NOT NULL REFERENCES epic (id),
  linear_issue_id TEXT NOT NULL,
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
    'completed',
    'merged',
    'cancelled'
  )),
  branch_name TEXT NOT NULL,
  position INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  task_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  checkpoint TEXT CHECK (checkpoint IS NULL OR json_valid(checkpoint)),
  recovery_attempts INTEGER NOT NULL DEFAULT 0,
  awake_ms INTEGER NOT NULL DEFAULT 0,
  last_mono_ms INTEGER,
  turn_count INTEGER NOT NULL DEFAULT 0,
  max_turns INTEGER NOT NULL DEFAULT 80,
  max_awake_ms INTEGER NOT NULL DEFAULT 2700000,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  session_key TEXT,
  current_run_id TEXT,
  brief TEXT CHECK (brief IS NULL OR json_valid(brief))
) STRICT;
INSERT INTO work_item_task_identity SELECT id,epic_id,linear_issue_id,linear_identifier,title,state,branch_name,position,version,'initial:' || linear_issue_id,created_at,checkpoint,recovery_attempts,awake_ms,last_mono_ms,turn_count,max_turns,max_awake_ms,cancel_requested,session_key,current_run_id,brief FROM work_item;
DROP TABLE work_item;
ALTER TABLE work_item_task_identity RENAME TO work_item;
CREATE INDEX work_item_epic_position ON work_item (epic_id, position);
CREATE TABLE linear_session (
  session_id TEXT PRIMARY KEY,
  issue_id TEXT,
  organization_id TEXT,
  app_user_id TEXT,
  creator_id TEXT,
  current_epic_id TEXT REFERENCES epic(id),
  active_item_id TEXT REFERENCES work_item(id),
  generation INTEGER NOT NULL DEFAULT 0,
  stopped_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE linear_session_task (
  session_id TEXT NOT NULL REFERENCES linear_session(session_id),
  epic_id TEXT NOT NULL UNIQUE REFERENCES epic(id),
  owner_actor_id TEXT,
  PRIMARY KEY (session_id, epic_id)
) STRICT;
CREATE TABLE linear_turn (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key TEXT NOT NULL UNIQUE,
  activity_id TEXT UNIQUE,
  session_id TEXT NOT NULL REFERENCES linear_session(session_id),
  actor_id TEXT,
  body TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  created_at_ms INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  item_id TEXT REFERENCES work_item(id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','applied','cancelled'))
) STRICT;
CREATE INDEX linear_turn_pending ON linear_turn(session_id,state,created_at_ms,ordinal);
INSERT INTO linear_session (session_id, issue_id, current_epic_id, active_item_id, generation, created_at)
SELECT session_key, linear_issue_id, epic_id, id, generation, created_at FROM (
  SELECT w.session_key, e.linear_issue_id, w.epic_id, w.id, COALESCE(f.generation,0) AS generation, w.created_at,
    ROW_NUMBER() OVER (PARTITION BY w.session_key ORDER BY CASE
      WHEN w.state NOT IN ('queued','merged','cancelled','completed') THEN 0
      WHEN w.state = 'queued' THEN 1 ELSE 2 END, w.position, w.created_at, w.id) AS route_rank
  FROM work_item w JOIN epic e ON e.id = w.epic_id
  LEFT JOIN outbox_session_fence f ON f.target = 'linear' AND f.ordering_key = w.session_key
  WHERE w.session_key IS NOT NULL AND w.linear_issue_id NOT LIKE 'github:%'
    AND e.linear_issue_id NOT LIKE 'github:%' AND w.session_key != w.linear_issue_id
    AND w.session_key != e.linear_issue_id
) WHERE route_rank = 1;
INSERT INTO linear_session_task (session_id,epic_id) SELECT session_id,current_epic_id FROM linear_session;
`,
  },
  {
    id: "015_work_item_task",
    sql: `
CREATE TABLE work_item_task (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  mode TEXT NOT NULL CHECK (mode IN ('code', 'answer', 'artifact')),
  response TEXT
) STRICT;
`,
  },
  {
    id: "014_linear_artifacts",
    sql: `
CREATE TABLE linear_artifact (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  run_id TEXT NOT NULL,
  path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  request_version INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('pending', 'uploaded', 'failed')),
  asset_url TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(item_id, path, display_name, mime_type, sha256)
) STRICT;
`,
  },
  {
    id: "015_linear_inputs",
    sql: `
CREATE TABLE linear_input (
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  asset_url TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY(session_id, turn_id, asset_id)
) STRICT;
`,
  },
  {
    id: "017_task_mode_generation",
    sql: `ALTER TABLE work_item_task ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;`,
  },
  {
    id: "016_task_request",
    sql: `
CREATE TABLE task_request (
  task_key TEXT PRIMARY KEY,
  classification TEXT NOT NULL CHECK (json_valid(classification))
) STRICT;
`,
  },
  {
    id: "018_acp_conversation",
    sql: `CREATE TABLE linear_conversation (
      item_id TEXT PRIMARY KEY REFERENCES work_item(id),
      entries TEXT NOT NULL CHECK(json_valid(entries)),
      transcript TEXT,
      transcript_offset INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1))
    ) STRICT;`,
  },
  {
    id: "019_linear_turn_announcements",
    sql: "ALTER TABLE linear_turn ADD COLUMN announced_generation INTEGER;",
  },
  {
    id: "020_linear_stop_receipts",
    sql: `CREATE TABLE linear_stop_receipt (
      session_id TEXT NOT NULL REFERENCES linear_session(session_id),
      event_key TEXT NOT NULL,
      generation INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(session_id,event_key)
    ) STRICT;`,
  },
  {
    id: "021_linear_session_cleanup_block",
    sql: `CREATE TABLE linear_session_cleanup_block (
      session_id TEXT PRIMARY KEY REFERENCES linear_session(session_id)
    ) STRICT;`,
  },
  {
    id: "011_work_item_repository",
    sql: `
CREATE TABLE work_item_repository (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  remote_url TEXT NOT NULL
) STRICT;
`,
  },
  {
    id: "012_repository_question",
    sql: `
CREATE TABLE work_item_repository_question (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  question_id TEXT NOT NULL REFERENCES question(id),
  candidates TEXT NOT NULL CHECK (json_valid(candidates))
) STRICT;
`,
  },
  {
    id: "021_task_repository_context",
    sql: "ALTER TABLE work_item_task ADD COLUMN repository_context INTEGER NOT NULL DEFAULT 0 CHECK(repository_context IN (0,1));",
  },
  {
    id: "018_linear_artifact_attempts",
    sql: `
ALTER TABLE linear_artifact ADD COLUMN identity_hash TEXT;
CREATE TABLE linear_artifact_attempt (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  identity_hash TEXT NOT NULL,
  version INTEGER NOT NULL,
  completed_version INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(item_id, identity_hash)
) STRICT;
`,
  },
  {
    id: "019_linear_artifact_cards",
    sql: `ALTER TABLE linear_artifact_attempt ADD COLUMN attachment_requested INTEGER NOT NULL DEFAULT 0 CHECK (attachment_requested IN (0, 1));`,
  },
  {
    id: "011_linear_question_lifecycle",
    sql: `
ALTER TABLE question ADD COLUMN cancelled_at INTEGER;
ALTER TABLE question ADD COLUMN answer_event_key TEXT;
UPDATE question SET cancelled_at = created_at
WHERE status = 'open' AND (
  item_id IN (SELECT id FROM work_item WHERE state IN ('cancelled', 'merged', 'failed'))
  OR EXISTS (
    SELECT 1 FROM question newer
    WHERE newer.session_id = question.session_id AND newer.status = 'open'
      AND (newer.created_at > question.created_at
        OR (newer.created_at = question.created_at AND newer.id > question.id))
  )
);
CREATE UNIQUE INDEX question_one_active_session ON question (session_id)
WHERE status = 'open' AND cancelled_at IS NULL;
CREATE UNIQUE INDEX question_answer_event ON question (session_id, answer_event_key)
WHERE answer_event_key IS NOT NULL;
`,
  },
  {
    id: "013_linear_installation_access",
    sql: `
ALTER TABLE linear_session ADD COLUMN oauth_client_id TEXT;
ALTER TABLE linear_session ADD COLUMN team_id TEXT;
ALTER TABLE linear_session ADD COLUMN installation_observed_at INTEGER;
CREATE TABLE linear_app_revocation (
  organization_id TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL,
  revoked_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, oauth_client_id)
) STRICT;
CREATE TABLE linear_team_access (
  organization_id TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL,
  app_user_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, oauth_client_id, app_user_id, team_id)
) STRICT;
CREATE TABLE linear_installation_permission (
  organization_id TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL,
  app_user_id TEXT NOT NULL,
  all_public_teams INTEGER NOT NULL CHECK (all_public_teams IN (0, 1)),
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, oauth_client_id, app_user_id)
) STRICT;
CREATE TABLE linear_access_event (
  event_key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
) STRICT;
`,
  },
  {
    id: "014_linear_verified_reconnect",
    sql: `
ALTER TABLE linear_app_revocation ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE linear_app_revocation ADD COLUMN restored_after INTEGER;
ALTER TABLE linear_app_revocation ADD COLUMN restored_credential_fingerprint TEXT;
`,
  },
  {
    id: "012_linear_github_auth",
    sql: `
CREATE TABLE linear_github_auth (
  question_id TEXT PRIMARY KEY REFERENCES question(id),
  item_id TEXT NOT NULL REFERENCES work_item(id),
  actor_id TEXT NOT NULL,
  github_account_id INTEGER,
  phase TEXT NOT NULL CHECK (phase IN ('initial', 'publication')),
  generation INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified', 'expired', 'revoked')),
  expires_at INTEGER NOT NULL,
  verified_at INTEGER
) STRICT;
CREATE INDEX linear_github_auth_pending ON linear_github_auth (item_id, status);
`,
  },
  {
    id: "017_linear_task_delegation",
    sql: `
CREATE TABLE linear_task_delegation (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  issue_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  app_user_id TEXT NOT NULL,
  human_actor_id TEXT,
  PRIMARY KEY (item_id, issue_id)
) STRICT;
`,
  },
  {
    id: "018_remote_merge_fact",
    sql: `
CREATE TABLE remote_merge_fact (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  repository_owner TEXT NOT NULL CHECK (length(repository_owner) > 0),
  repository_name TEXT NOT NULL CHECK (length(repository_name) > 0),
  pull_number INTEGER NOT NULL CHECK (pull_number > 0),
  pull_url TEXT,
  merge_sha TEXT,
  confirmed_at INTEGER NOT NULL CHECK (confirmed_at >= 0)
) STRICT;
`,
  },
  {
    id: "019_linear_auth_session_generation",
    sql: `
ALTER TABLE linear_github_auth ADD COLUMN session_generation INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: "020_linear_github_task_account",
    sql: `
CREATE TABLE linear_github_task_account (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  account_id INTEGER NOT NULL CHECK (account_id > 0),
  login TEXT NOT NULL,
  verified_at INTEGER NOT NULL
) STRICT;
`,
  },
  {
    id: "022_work_item_repository_choice",
    sql: "ALTER TABLE work_item_repository_question ADD COLUMN chosen_repository TEXT CHECK(chosen_repository IS NULL OR json_valid(chosen_repository));",
  },
  {
    id: "021_linear_issue_context",
    sql: `
CREATE TABLE linear_issue_context (
  session_id TEXT NOT NULL REFERENCES linear_session(session_id),
  issue_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  context TEXT NOT NULL,
  PRIMARY KEY (session_id,issue_id)
) STRICT;
`,
  },
  {
    id: "023_workspace_access",
    sql: `
CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  linear_organization_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE workspace_user (
  id TEXT PRIMARY KEY,
  linear_user_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL
) STRICT;
CREATE TABLE workspace_member (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  user_id TEXT NOT NULL REFERENCES workspace_user(id),
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member','observer')),
  source TEXT NOT NULL CHECK(source IN ('linear','manual')),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  checked_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,user_id)
) STRICT;
CREATE TABLE workspace_user_team (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,user_id,team_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_member(workspace_id,user_id)
) STRICT;
CREATE TABLE workspace_repository (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  repository TEXT NOT NULL,
  team_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,repository,team_id)
) STRICT;
CREATE TABLE workspace_session (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES workspace_user(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  csrf_token TEXT NOT NULL,
  authenticated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE workspace_bootstrap (
  token_hash TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
) STRICT;
CREATE TABLE workspace_oauth_request (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  bootstrap_hash TEXT,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE workspace_access_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT REFERENCES workspace(id),
  user_id TEXT REFERENCES workspace_user(id),
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
`,
  },
  {
    id: "026_workspace_manual_roles",
    sql: `ALTER TABLE workspace_member ADD COLUMN manual_role TEXT
      CHECK(manual_role IN ('owner','admin','member','observer'));`,
  },
  {
    id: "027_workspace_identity_links",
    sql: `
CREATE TABLE workspace_identity_link (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  user_id TEXT NOT NULL REFERENCES workspace_user(id),
  provider TEXT NOT NULL CHECK(provider IN ('slack','github')),
  external_id TEXT,
  installation_id TEXT,
  method TEXT NOT NULL CHECK(method IN ('email','manual')),
  status TEXT NOT NULL CHECK(status IN ('linked','unmatched','error')),
  checked_at INTEGER NOT NULL,
  PRIMARY KEY(workspace_id,user_id,provider),
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_member(workspace_id,user_id),
  UNIQUE(workspace_id,provider,external_id),
  CHECK((status='linked' AND external_id IS NOT NULL) OR (status!='linked' AND external_id IS NULL))
) STRICT;
`,
  },
  {
    id: "024_runner_identity",
    sql: `
CREATE TABLE runner (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','paused','draining','revoked')),
  fence INTEGER NOT NULL DEFAULT 0 CHECK(fence >= 0),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_member(workspace_id,user_id)
) STRICT;
CREATE TABLE runner_certificate (
  fingerprint TEXT PRIMARY KEY,
  serial TEXT NOT NULL UNIQUE,
  runner_id TEXT NOT NULL REFERENCES runner(id),
  pem TEXT NOT NULL,
  not_before INTEGER NOT NULL,
  not_after INTEGER NOT NULL,
  accepted_until INTEGER NOT NULL,
  revoked_at INTEGER
) STRICT;
CREATE INDEX runner_certificate_identity ON runner_certificate(runner_id);
CREATE TABLE runner_pairing (
  id TEXT PRIMARY KEY,
  claim_hash TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL UNIQUE,
  csr TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  name TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_by TEXT REFERENCES workspace_user(id),
  claimed_at INTEGER,
  runner_id TEXT REFERENCES runner(id),
  certificate_fingerprint TEXT REFERENCES runner_certificate(fingerprint)
) STRICT;
CREATE TRIGGER revoke_member_runners AFTER UPDATE OF active ON workspace_member
WHEN NEW.active=0
BEGIN
  UPDATE runner SET status='revoked',revoked_at=NEW.checked_at,fence=fence+1
  WHERE workspace_id=NEW.workspace_id AND owner_user_id=NEW.user_id AND revoked_at IS NULL;
  UPDATE runner_certificate SET revoked_at=NEW.checked_at WHERE revoked_at IS NULL
  AND runner_id IN (SELECT id FROM runner WHERE workspace_id=NEW.workspace_id AND owner_user_id=NEW.user_id);
END;
`,
  },
  {
    id: "025_runner_work",
    sql: `
CREATE TABLE runner_work (
  run_id TEXT PRIMARY KEY REFERENCES run(id),
  runner_id TEXT NOT NULL REFERENCES runner(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  generation INTEGER NOT NULL CHECK(generation>0),
  runner_fence INTEGER NOT NULL CHECK(runner_fence>=0),
  command_id TEXT NOT NULL UNIQUE,
  lease_until INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence>=0),
  ended_at INTEGER
) STRICT;
CREATE TABLE runner_command (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  runner_id TEXT NOT NULL REFERENCES runner(id),
  run_id TEXT REFERENCES run(id),
  generation INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('run','review','cancel','probe','login_check','upgrade')),
  envelope TEXT NOT NULL CHECK(json_valid(envelope)),
  expires_at INTEGER NOT NULL,
  acknowledged_at INTEGER
) STRICT;
CREATE INDEX runner_command_pending ON runner_command(runner_id,acknowledged_at,ordinal);
CREATE TABLE runner_work_grant (
  token_hash TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runner_work(run_id),
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE runner_event (
  run_id TEXT NOT NULL REFERENCES runner_work(run_id),
  generation INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  received_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,generation,sequence)
) STRICT;
`,
  },
  {
    id: "028_runner_results",
    sql: `
CREATE TABLE runner_result (
  run_id TEXT NOT NULL REFERENCES runner_work(run_id),
  generation INTEGER NOT NULL CHECK(generation>0),
  command_id TEXT NOT NULL REFERENCES runner_command(id),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  received_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,generation)
) STRICT;
CREATE TABLE runner_question_answer (
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  answer TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,generation,sequence),
  FOREIGN KEY(run_id,generation,sequence) REFERENCES runner_event(run_id,generation,sequence)
) STRICT;
`,
  },
  {
    id: "029_runner_health",
    sql: `
ALTER TABLE runner ADD COLUMN last_seen_at INTEGER;
CREATE TABLE runner_health_result (
  command_id TEXT PRIMARY KEY REFERENCES runner_command(id),
  runner_id TEXT NOT NULL REFERENCES runner(id),
  result_json TEXT NOT NULL,
  received_at INTEGER NOT NULL
) STRICT;
`,
  },
  {
    id: "033_runner_transcripts",
    sql: `
CREATE TABLE runner_transcript (
  run_id TEXT NOT NULL REFERENCES run(id),
  generation INTEGER NOT NULL CHECK(generation>0),
  command_id TEXT NOT NULL UNIQUE REFERENCES runner_command(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  execution_id TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes BETWEEN 0 AND 16777216),
  sealed_size INTEGER CHECK(sealed_size IS NULL OR sealed_size=size_bytes),
  sha256 TEXT CHECK(sha256 IS NULL OR length(sha256)=64),
  uri TEXT,
  PRIMARY KEY(run_id,generation)
) STRICT;
CREATE TABLE runner_transcript_chunk (
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  offset INTEGER NOT NULL CHECK(offset>=0),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 524288),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  PRIMARY KEY(run_id,generation,offset),
  FOREIGN KEY(run_id,generation) REFERENCES runner_transcript(run_id,generation)
) STRICT;
`,
  },
  {
    id: "034_runner_verifier_identity",
    sql: `
ALTER TABLE runner_pairing ADD COLUMN verifier_public_key TEXT;
ALTER TABLE runner_pairing ADD COLUMN verifier_fingerprint TEXT
CHECK((verifier_public_key IS NULL AND verifier_fingerprint IS NULL)
OR (verifier_public_key IS NOT NULL AND verifier_fingerprint IS NOT NULL AND length(verifier_fingerprint)=64));
CREATE TABLE runner_verifier (
  runner_id TEXT PRIMARY KEY REFERENCES runner(id),
  public_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
  approved_by TEXT NOT NULL REFERENCES workspace_user(id),
  approved_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER immutable_runner_verifier BEFORE UPDATE ON runner_verifier
BEGIN
  SELECT RAISE(ABORT,'Verifier identity is immutable');
END;
CREATE TRIGGER immutable_pairing_verifier BEFORE UPDATE OF verifier_public_key,verifier_fingerprint ON runner_pairing
BEGIN
  SELECT RAISE(ABORT,'Pairing verifier identity is immutable');
END;
`,
  },
  {
    id: "035_runner_check_commands",
    foreignKeys: false,
    sql: `
CREATE TABLE runner_command_with_checks (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  runner_id TEXT NOT NULL REFERENCES runner(id),
  run_id TEXT REFERENCES run(id),
  generation INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('run','review','check','cancel','probe','login_check','upgrade')),
  envelope TEXT NOT NULL CHECK(json_valid(envelope)),
  expires_at INTEGER NOT NULL,
  acknowledged_at INTEGER
) STRICT;
INSERT INTO runner_command_with_checks SELECT * FROM runner_command;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'runner_command_with_checks',seq FROM sqlite_sequence WHERE name='runner_command'
AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='runner_command_with_checks');
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='runner_command'),0))
WHERE name='runner_command_with_checks';
DROP TABLE runner_command;
ALTER TABLE runner_command_with_checks RENAME TO runner_command;
CREATE INDEX runner_command_pending ON runner_command(runner_id,acknowledged_at,ordinal);
`,
  },
  {
    id: "036_runner_checks",
    sql: `
CREATE TABLE runner_check_attempt (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES run(id),
  runner_id TEXT NOT NULL REFERENCES runner(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  runner_fence INTEGER NOT NULL,
  candidate_sha TEXT NOT NULL
) STRICT;
CREATE TABLE runner_check_execution (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES runner_check_attempt(id),
  command_id TEXT NOT NULL UNIQUE REFERENCES runner_command(id),
  generation INTEGER NOT NULL,
  input TEXT NOT NULL CHECK(json_valid(input)),
  input_sha256 TEXT NOT NULL,
  result TEXT CHECK(result IS NULL OR json_valid(result)),
  grant_hash TEXT,
  receipt_until INTEGER,
  cancelled_at INTEGER
) STRICT;
CREATE INDEX runner_check_attempt_execution ON runner_check_execution(attempt_id,generation);
`,
  },
  {
    id: "037_runner_helpers",
    sql: `
CREATE TABLE runner_helper (
  id TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL REFERENCES runner(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  session_id TEXT NOT NULL REFERENCES linear_session(session_id),
  session_generation INTEGER NOT NULL,
  runner_fence INTEGER NOT NULL,
  envelope TEXT NOT NULL CHECK(json_valid(envelope)),
  expires_at INTEGER NOT NULL,
  acknowledged_at INTEGER,
  ended_at INTEGER,
  result TEXT CHECK(result IS NULL OR json_valid(result))
) STRICT;
CREATE INDEX runner_helper_pending ON runner_helper(runner_id,acknowledged_at,expires_at);
`,
  },
  {
    id: "038_runner_task_commands",
    foreignKeys: false,
    sql: `
CREATE TABLE runner_command_with_tasks (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  runner_id TEXT NOT NULL REFERENCES runner(id),
  run_id TEXT REFERENCES run(id),
  generation INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('run','review','check','task','cancel','probe','login_check','upgrade')),
  envelope TEXT NOT NULL CHECK(json_valid(envelope)),
  expires_at INTEGER NOT NULL,
  acknowledged_at INTEGER
) STRICT;
INSERT INTO runner_command_with_tasks SELECT * FROM runner_command;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'runner_command_with_tasks',seq FROM sqlite_sequence WHERE name='runner_command'
AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='runner_command_with_tasks');
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='runner_command'),0))
WHERE name='runner_command_with_tasks';
DROP TABLE runner_command;
ALTER TABLE runner_command_with_tasks RENAME TO runner_command;
CREATE INDEX runner_command_pending ON runner_command(runner_id,acknowledged_at,ordinal);
`,
  },
  {
    id: "039_epic_dependencies",
    sql: `
CREATE TABLE epic_dependency_snapshot (
  epic_id TEXT PRIMARY KEY REFERENCES epic(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  generation INTEGER NOT NULL CHECK(generation>0),
  scope TEXT NOT NULL CHECK(json_valid(scope)),
  linear_states TEXT NOT NULL CHECK(json_valid(linear_states))
) STRICT;
CREATE TABLE external_dep (
  epic_id TEXT NOT NULL REFERENCES epic(id),
  blocker_linear_issue_id TEXT NOT NULL,
  blocked_linear_issue_id TEXT NOT NULL,
  PRIMARY KEY(epic_id,blocker_linear_issue_id,blocked_linear_issue_id)
) STRICT;
CREATE INDEX external_dep_blocker ON external_dep(blocker_linear_issue_id,epic_id);
`,
  },
  {
    id: "040_scheduler_admission",
    sql: `
CREATE TABLE work_item_scheduling (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  project_id TEXT,
  project_known INTEGER NOT NULL CHECK(project_known IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 4),
  paths TEXT CHECK(paths IS NULL OR json_valid(paths))
) STRICT;
CREATE TABLE scheduler_admission (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  job_id INTEGER NOT NULL UNIQUE REFERENCES job(id),
  project_key TEXT NOT NULL,
  repository_key TEXT NOT NULL,
  session_id TEXT REFERENCES linear_session(session_id),
  paths TEXT NOT NULL CHECK(json_valid(paths)),
  hot INTEGER NOT NULL CHECK(hot IN (0,1)),
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX scheduler_project ON scheduler_admission(project_key);
`,
  },
  {
    id: "042_runner_placement",
    sql: `
CREATE TABLE workspace_runner_policy (
 workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
 fallback_allowed INTEGER NOT NULL DEFAULT 0 CHECK(fallback_allowed IN (0,1)),
 personal_organization_host INTEGER NOT NULL DEFAULT 0 CHECK(personal_organization_host IN (0,1))
) STRICT;
CREATE TABLE runner_policy (
 runner_id TEXT PRIMARY KEY REFERENCES runner(id),
 host_owner TEXT NOT NULL DEFAULT 'unknown' CHECK(host_owner IN ('member','workspace','unknown')),
 sharing INTEGER NOT NULL DEFAULT 0 CHECK(sharing IN (0,1)),
 fallback INTEGER NOT NULL DEFAULT 0 CHECK(fallback IN (0,1))
) STRICT;
CREATE TABLE runner_agent_policy (
 runner_id TEXT NOT NULL REFERENCES runner(id),
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex','grok')),
 seat TEXT NOT NULL DEFAULT 'unknown' CHECK(seat IN ('unknown','personal','organization','api')),
 ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1)),
 auth_expired INTEGER NOT NULL DEFAULT 0 CHECK(auth_expired IN (0,1)),
 quota_state TEXT NOT NULL DEFAULT 'ok' CHECK(quota_state IN ('ok','low','exhausted')),
 resets_at INTEGER,
 cooldown_until INTEGER NOT NULL DEFAULT 0,
 resolved_model TEXT,
 last_used_at INTEGER NOT NULL DEFAULT 0,
 virtual_finish REAL NOT NULL DEFAULT 0,
 PRIMARY KEY(runner_id,agent)
) STRICT;
CREATE TABLE runner_execution_usage (
 command_id TEXT PRIMARY KEY,
 runner_id TEXT NOT NULL REFERENCES runner(id),
 owner_user_id TEXT NOT NULL REFERENCES workspace_user(id),
 item_id TEXT REFERENCES work_item(id),
 run_id TEXT REFERENCES run(id),
 agent TEXT CHECK(agent IN ('claude','codex','grok')),
 model TEXT,
 seat TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('implementer','reviewer')),
 purpose TEXT NOT NULL CHECK(purpose IN ('prepare','work','check','helper')),
 started_at INTEGER NOT NULL,
 ended_at INTEGER,
 outcome TEXT,
 resolved_model TEXT,
 output_bytes INTEGER NOT NULL DEFAULT 0 CHECK(output_bytes>=0)
) STRICT;
CREATE INDEX runner_usage_item ON runner_execution_usage(item_id,ended_at);
`,
  },
  {
    id: "041_item_specifications",
    sql: `
CREATE TABLE work_item_specification (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  present INTEGER NOT NULL CHECK(present IN (0,1))
) STRICT;
CREATE TABLE epic_reconciliation_request (
  epic_id TEXT PRIMARY KEY REFERENCES epic(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  token TEXT NOT NULL
) STRICT;
CREATE TABLE epic_reconciliation_effect (
  epic_id TEXT NOT NULL REFERENCES epic(id),
  item_id TEXT NOT NULL REFERENCES work_item(id),
  kind TEXT NOT NULL CHECK(kind IN ('spec','removed','canceled')),
  token TEXT NOT NULL,
  PRIMARY KEY(epic_id,item_id,kind)
) STRICT;
`,
  },
  {
    id: "043_epic_execution_control",
    sql: `
CREATE TABLE epic_execution_control (
  epic_id TEXT PRIMARY KEY REFERENCES epic(id),
  blocked_since INTEGER,
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('completed','abandoned')),
  stalled_question_id TEXT REFERENCES question(id),
  notice_generation INTEGER NOT NULL DEFAULT 0 CHECK(notice_generation>=0)
) STRICT;
`,
  },
  {
    id: "045_linear_activity_budget",
    sql: `
ALTER TABLE outbox ADD COLUMN activity_run_id TEXT REFERENCES run(id);
CREATE INDEX outbox_activity_run ON outbox(activity_run_id,sent_at);
CREATE TABLE linear_outbox_backoff (
 id INTEGER PRIMARY KEY CHECK(id=1),
 not_before INTEGER NOT NULL
) STRICT;
`,
  },
  {
    id: "046_workspace_assignment_handoff",
    sql: `
ALTER TABLE workspace_oauth_request ADD COLUMN assignment_hash TEXT;
CREATE TABLE workspace_assignment (
 session_id TEXT NOT NULL REFERENCES linear_session(session_id),
 generation INTEGER NOT NULL,
 workspace_id TEXT NOT NULL REFERENCES workspace(id),
 actor_id TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 fingerprint TEXT NOT NULL,
 event TEXT NOT NULL CHECK(json_valid(event)),
 expires_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','ready','accepted','continued','invalid')),
 PRIMARY KEY(session_id,generation)
) STRICT;
`,
  },
  {
    id: "047_github_integration_holds",
    sql: `
CREATE TABLE github_integration_hold (
 question_id TEXT PRIMARY KEY REFERENCES question(id),
 item_id TEXT NOT NULL REFERENCES work_item(id),
 phase TEXT NOT NULL CHECK(phase IN ('initial','publication')),
 item_version INTEGER NOT NULL,
 session_generation INTEGER NOT NULL,
 current_run_id TEXT,
 checkpoint TEXT NOT NULL,
 authority TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','revoked'))
) STRICT;
CREATE INDEX github_integration_hold_pending ON github_integration_hold(status,item_id);
`,
  },
  {
    id: "048_workspace_github_connect",
    sql: `
CREATE TABLE workspace_github_connection (
 workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
 generation INTEGER NOT NULL DEFAULT 0,
 secret_id TEXT,
 actor_id TEXT REFERENCES workspace_user(id),
 installation_id TEXT,
 repositories TEXT NOT NULL DEFAULT '[]'
) STRICT;
CREATE TABLE workspace_github_oauth (
 state_hash TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspace(id),
 user_id TEXT NOT NULL REFERENCES workspace_user(id),
 session_hash TEXT NOT NULL,
 secret_id TEXT NOT NULL,
 expected_generation INTEGER NOT NULL,
 intent TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','complete','failed'))
) STRICT;
`,
  },
  {
    id: "049_verified_github_attribution",
    sql: `
CREATE TABLE verified_github_attribution (
 workspace_id TEXT NOT NULL REFERENCES workspace(id),
 user_id TEXT NOT NULL REFERENCES workspace_user(id),
 github_id INTEGER CHECK(github_id>0),
 login TEXT,
 name TEXT,
 consented_at INTEGER,
 revoked_at INTEGER,
 revision INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,user_id)
) STRICT;
CREATE UNIQUE INDEX verified_github_attribution_account ON verified_github_attribution(workspace_id,github_id) WHERE consented_at IS NOT NULL AND revoked_at IS NULL;
CREATE TABLE github_attribution_request (
 state_hash TEXT PRIMARY KEY,
 browser_hash TEXT NOT NULL,
 session_hash TEXT NOT NULL REFERENCES workspace_session(token_hash) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspace(id),
 user_id TEXT NOT NULL REFERENCES workspace_user(id),
 revision INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
) STRICT;
`,
  },
  {
    id: "054_external_blocker_policy",
    sql: `
CREATE TABLE external_blocker_policy (
 workspace_id TEXT NOT NULL REFERENCES workspace(id),
 epic_id TEXT NOT NULL REFERENCES epic(id),
 blocker_issue_id TEXT NOT NULL,
 policy TEXT NOT NULL CHECK(json_valid(policy)),
 user_id TEXT NOT NULL REFERENCES workspace_user(id),
 revision INTEGER NOT NULL,
 PRIMARY KEY(epic_id,blocker_issue_id)
) STRICT;
ALTER TABLE epic_dependency_snapshot ADD COLUMN external_evidence TEXT NOT NULL DEFAULT '{}';
`,
  },
  {
    id: "052_project_approval",
    sql: `
CREATE TABLE project_approval (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspace(id),
 project_id TEXT NOT NULL,
 actor_id TEXT NOT NULL REFERENCES workspace_user(id),
 lead_user_id TEXT NOT NULL REFERENCES workspace_user(id),
 generation TEXT NOT NULL,
 preview TEXT NOT NULL CHECK(json_valid(preview)),
 created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL,
 approved_at INTEGER,
 paused_at INTEGER,
 stopped_at INTEGER,
 last_error TEXT
) STRICT;
CREATE UNIQUE INDEX project_approval_current ON project_approval(workspace_id,actor_id,generation) WHERE stopped_at IS NULL;
CREATE TABLE project_approval_issue (
 workspace_id TEXT NOT NULL REFERENCES workspace(id),
 issue_id TEXT NOT NULL,
 approval_id TEXT NOT NULL REFERENCES project_approval(id),
 session_id TEXT UNIQUE,
 epic_id TEXT REFERENCES epic(id),
 released_at INTEGER,
 PRIMARY KEY(approval_id,issue_id)
) STRICT;
CREATE UNIQUE INDEX project_approval_issue_active ON project_approval_issue(workspace_id,issue_id) WHERE released_at IS NULL;
`,
  },
  {
    id: "053_runner_member_accounts",
    foreignKeys: false,
    sql: `
CREATE TABLE runner_command_with_login (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  runner_id TEXT NOT NULL REFERENCES runner(id),
  run_id TEXT REFERENCES run(id),
  generation INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('run','review','check','task','cancel','probe','login_check','login','upgrade')),
  envelope TEXT NOT NULL CHECK(json_valid(envelope)),
  expires_at INTEGER NOT NULL,
  acknowledged_at INTEGER
) STRICT;
INSERT INTO runner_command_with_login SELECT * FROM runner_command;
INSERT INTO sqlite_sequence(name,seq)
SELECT 'runner_command_with_login',seq FROM sqlite_sequence WHERE name='runner_command'
AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='runner_command_with_login');
UPDATE sqlite_sequence SET seq=MAX(seq,COALESCE((SELECT seq FROM sqlite_sequence WHERE name='runner_command'),0))
WHERE name='runner_command_with_login';
DROP TABLE runner_command;
ALTER TABLE runner_command_with_login RENAME TO runner_command;
CREATE INDEX runner_command_pending ON runner_command(runner_id,acknowledged_at,ordinal);
CREATE TABLE runner_member_account (
 runner_id TEXT NOT NULL REFERENCES runner(id),
 user_id TEXT NOT NULL REFERENCES workspace_user(id),
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex')),
 connected INTEGER NOT NULL DEFAULT 0 CHECK(connected IN (0,1)),
 cooldown_until INTEGER NOT NULL DEFAULT 0,
 resolved_model TEXT,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(runner_id,user_id,agent)
) STRICT;
CREATE TABLE runner_login (
 id TEXT PRIMARY KEY REFERENCES runner_command(id),
 runner_id TEXT NOT NULL REFERENCES runner(id),
 workspace_id TEXT NOT NULL REFERENCES workspace(id),
 user_id TEXT NOT NULL REFERENCES workspace_user(id),
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex')),
 state TEXT NOT NULL CHECK(state IN ('starting','waiting','connected','failed','cancelled','expired')),
 expires_at INTEGER NOT NULL,
 terminal TEXT NOT NULL DEFAULT '',
 authorization TEXT,
 input_id TEXT,
 updated_at INTEGER NOT NULL
) STRICT;
CREATE INDEX runner_login_account ON runner_login(runner_id,user_id,agent,updated_at);
`,
  },
  {
    id: "051_decision_memory",
    sql: `
CREATE TABLE decision_memory (
 id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL REFERENCES workspace(id),
 question_id TEXT NOT NULL UNIQUE REFERENCES question(id),
 statement TEXT NOT NULL,
 scope_globs TEXT NOT NULL CHECK(json_valid(scope_globs)),
 tags TEXT NOT NULL CHECK(json_valid(tags)),
 revision INTEGER NOT NULL DEFAULT 1,
 retired_at INTEGER,
 saved_by TEXT NOT NULL REFERENCES workspace_user(id),
 updated_by TEXT NOT NULL REFERENCES workspace_user(id),
 updated_at INTEGER NOT NULL
) STRICT;
CREATE VIRTUAL TABLE decision_memory_search USING fts5(decision_id UNINDEXED, statement, tags);
CREATE TABLE decision_suggestion (
 id TEXT PRIMARY KEY,
 question_id TEXT NOT NULL REFERENCES question(id),
 decision_id TEXT NOT NULL REFERENCES decision_memory(id),
 revision INTEGER NOT NULL,
 statement TEXT NOT NULL,
 accepted_by TEXT,
 accepted_at INTEGER,
 UNIQUE(question_id,decision_id)
) STRICT;
CREATE UNIQUE INDEX decision_suggestion_answer ON decision_suggestion(question_id) WHERE accepted_at IS NOT NULL;
`,
  },
  {
    id: "055_runner_capacity",
    sql: `
CREATE TABLE runner_capacity (
 runner_id TEXT PRIMARY KEY REFERENCES runner(id),
 capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 16)
) STRICT;
`,
  },
  {
    id: "056_agent_model_catalog",
    sql: `
CREATE TABLE agent_model_catalog (
 runner_id TEXT NOT NULL REFERENCES runner(id),
 user_id TEXT NOT NULL REFERENCES workspace_user(id),
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex','grok')),
 model TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json)),
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(runner_id,user_id,agent,model)
) STRICT;
CREATE TABLE agent_model_probe (
 command_id TEXT PRIMARY KEY REFERENCES runner_command(id),
 runner_id TEXT NOT NULL REFERENCES runner(id),
 user_id TEXT NOT NULL REFERENCES workspace_user(id),
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex','grok')),
 model TEXT NOT NULL,
 requested_at INTEGER NOT NULL,
 finished_at INTEGER
) STRICT;
CREATE INDEX agent_model_probe_refresh ON agent_model_probe(runner_id,user_id,agent,model,requested_at);
CREATE UNIQUE INDEX agent_model_probe_pending ON agent_model_probe(runner_id) WHERE finished_at IS NULL;
`,
  },
  {
    id: "057_task_block",
    sql: `
CREATE TABLE task_block (
 blocker_linear_issue_id TEXT NOT NULL,
 blocked_linear_issue_id TEXT NOT NULL,
 PRIMARY KEY(blocked_linear_issue_id,blocker_linear_issue_id),
 CHECK(blocker_linear_issue_id <> blocked_linear_issue_id)
) STRICT;
CREATE INDEX task_block_blocker ON task_block(blocker_linear_issue_id);
ALTER TABLE work_item ADD COLUMN owner_user_id TEXT REFERENCES workspace_user(id);
ALTER TABLE work_item ADD COLUMN project_approval_id TEXT REFERENCES project_approval(id);
CREATE INDEX work_item_project_approval ON work_item(project_approval_id) WHERE project_approval_id IS NOT NULL;
ALTER TABLE project_approval ADD COLUMN source TEXT NOT NULL DEFAULT 'project' CHECK(source IN ('project','parent'));
`,
  },
  {
    id: "058_one_active_item",
    sql: `
CREATE TEMP TABLE retired_item AS SELECT id FROM work_item WHERE state NOT IN ('completed','merged','cancelled')
  AND EXISTS(SELECT 1 FROM work_item n WHERE n.linear_issue_id=work_item.linear_issue_id
    AND n.state NOT IN ('completed','merged','cancelled')
    AND (n.created_at>work_item.created_at OR (n.created_at=work_item.created_at AND n.id>work_item.id)));
UPDATE work_item SET state='cancelled',cancel_requested=1 WHERE id IN (SELECT id FROM retired_item);
UPDATE run SET status='ended' WHERE status IN ('active','provisioning') AND item_id IN (SELECT id FROM retired_item);
UPDATE job SET status='cancelled' WHERE status='pending' AND json_extract(payload,'$.itemId') IN (SELECT id FROM retired_item);
DROP TABLE retired_item;
INSERT OR IGNORE INTO task_block(blocker_linear_issue_id,blocked_linear_issue_id)
  SELECT b.blocker_linear_issue_id,b.blocked_linear_issue_id FROM work_item_block b
  JOIN work_item i ON i.epic_id=b.epic_id AND i.linear_issue_id=b.blocked_linear_issue_id
  WHERE i.state NOT IN ('completed','merged','cancelled') AND b.blocker_linear_issue_id<>b.blocked_linear_issue_id
  UNION SELECT d.blocker_linear_issue_id,d.blocked_linear_issue_id FROM external_dep d
  JOIN work_item i ON i.epic_id=d.epic_id AND i.linear_issue_id=d.blocked_linear_issue_id
  WHERE i.state NOT IN ('completed','merged','cancelled') AND d.blocker_linear_issue_id<>d.blocked_linear_issue_id;
CREATE UNIQUE INDEX work_item_active_issue ON work_item(linear_issue_id) WHERE state NOT IN ('completed','merged','cancelled');
`,
  },
  {
    id: "059_drop_old_blocks",
    sql: `
DROP TABLE work_item_block;
DROP TABLE external_dep;
DROP TABLE epic_execution_control;
`,
  },
  {
    id: "060_session_link_on_item",
    sql: `
CREATE TEMP TABLE session_link_backfill AS
SELECT w.id AS item_id, COALESCE(
  (SELECT s.session_id FROM linear_session s
    WHERE s.current_epic_id = w.epic_id
    ORDER BY s.created_at, s.session_id LIMIT 1),
  (SELECT s.session_id FROM linear_session_task t
    JOIN linear_session s ON s.session_id = t.session_id
    WHERE t.epic_id = w.epic_id
    ORDER BY s.created_at, s.session_id LIMIT 1)
) AS session_id
FROM work_item w WHERE w.session_key IS NULL;
UPDATE work_item SET
  session_key = (SELECT b.session_id FROM session_link_backfill b WHERE b.item_id = work_item.id),
  owner_user_id = COALESCE(work_item.owner_user_id, (
    SELECT u.id FROM session_link_backfill b
    JOIN linear_session_task t ON t.session_id = b.session_id AND t.epic_id = work_item.epic_id
    JOIN workspace_user u ON u.linear_user_id = t.owner_actor_id
    WHERE b.item_id = work_item.id
  ))
WHERE id IN (SELECT item_id FROM session_link_backfill WHERE session_id IS NOT NULL);
DROP TABLE session_link_backfill;
`,
  },
  {
    id: "061_drop_old_session_link",
    foreignKeys: false,
    sql: `
ALTER TABLE work_item ADD COLUMN delegated_by TEXT;
UPDATE work_item SET delegated_by=(
  SELECT t.owner_actor_id FROM linear_session_task t
  WHERE t.epic_id=work_item.epic_id);
DROP TABLE linear_session_task;
ALTER TABLE linear_session DROP COLUMN current_epic_id;
`,
  },
  {
    id: "062_item_dependency_snapshot",
    sql: `
CREATE TABLE item_dependency_snapshot (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  generation INTEGER NOT NULL CHECK(generation>0),
  scope TEXT NOT NULL CHECK(json_valid(scope)),
  linear_states TEXT NOT NULL CHECK(json_valid(linear_states)),
  external_evidence TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(external_evidence))
) STRICT;
`,
  },
  {
    id: "063_item_reconciliation",
    sql: `
CREATE TABLE item_reconciliation_request (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  token TEXT NOT NULL
) STRICT;
CREATE TABLE item_reconciliation_effect (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  kind TEXT NOT NULL CHECK(kind IN ('spec','removed','canceled')),
  token TEXT NOT NULL,
  PRIMARY KEY(item_id,kind)
) STRICT;
CREATE TABLE item_blocker_policy (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  item_id TEXT NOT NULL REFERENCES work_item(id),
  blocker_issue_id TEXT NOT NULL,
  policy TEXT NOT NULL CHECK(json_valid(policy)),
  user_id TEXT NOT NULL REFERENCES workspace_user(id),
  revision INTEGER NOT NULL,
  PRIMARY KEY(item_id,blocker_issue_id)
) STRICT;
INSERT INTO item_reconciliation_request(item_id,workspace_id,token)
SELECT i.id,r.workspace_id,r.token FROM epic_reconciliation_request r
JOIN work_item i ON i.epic_id=r.epic_id
WHERE i.state NOT IN ('completed','merged','cancelled');
INSERT INTO item_reconciliation_effect(item_id,kind,token)
SELECT item_id,kind,token FROM epic_reconciliation_effect;
INSERT INTO item_blocker_policy(workspace_id,item_id,blocker_issue_id,policy,user_id,revision)
SELECT p.workspace_id,i.id,p.blocker_issue_id,p.policy,p.user_id,p.revision
FROM external_blocker_policy p
JOIN work_item i ON i.epic_id=p.epic_id
WHERE i.state NOT IN ('completed','merged','cancelled');
`,
  },
  {
    id: "064_work_item_without_epic_fk",
    foreignKeys: false,
    sql: `
CREATE TABLE work_item_delegation (
  id TEXT PRIMARY KEY,
  epic_id TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
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
    'completed',
    'merged',
    'cancelled'
  )),
  branch_name TEXT NOT NULL,
  position INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  task_key TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  checkpoint TEXT CHECK (checkpoint IS NULL OR json_valid(checkpoint)),
  recovery_attempts INTEGER NOT NULL DEFAULT 0,
  awake_ms INTEGER NOT NULL DEFAULT 0,
  last_mono_ms INTEGER,
  turn_count INTEGER NOT NULL DEFAULT 0,
  max_turns INTEGER NOT NULL DEFAULT 80,
  max_awake_ms INTEGER NOT NULL DEFAULT 2700000,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  session_key TEXT,
  current_run_id TEXT,
  brief TEXT CHECK (brief IS NULL OR json_valid(brief)),
  owner_user_id TEXT REFERENCES workspace_user(id),
  project_approval_id TEXT REFERENCES project_approval(id),
  delegated_by TEXT
) STRICT;
INSERT INTO work_item_delegation (
  id, epic_id, linear_issue_id, linear_identifier, title, state, branch_name, position, version,
  task_key, created_at, checkpoint, recovery_attempts, awake_ms, last_mono_ms, turn_count,
  max_turns, max_awake_ms, cancel_requested, session_key, current_run_id, brief, owner_user_id,
  project_approval_id, delegated_by
)
SELECT
  id, epic_id, linear_issue_id, linear_identifier, title, state, branch_name, position, version,
  task_key, created_at, checkpoint, recovery_attempts, awake_ms, last_mono_ms, turn_count,
  max_turns, max_awake_ms, cancel_requested, session_key, current_run_id, brief, owner_user_id,
  project_approval_id, delegated_by
FROM work_item;
DROP TABLE work_item;
ALTER TABLE work_item_delegation RENAME TO work_item;
CREATE INDEX work_item_epic_position ON work_item (epic_id, position);
CREATE INDEX work_item_project_approval ON work_item(project_approval_id) WHERE project_approval_id IS NOT NULL;
CREATE UNIQUE INDEX work_item_active_issue ON work_item(linear_issue_id) WHERE state NOT IN ('completed','merged','cancelled');
CREATE TABLE project_approval_issue_delegation (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  issue_id TEXT NOT NULL,
  approval_id TEXT NOT NULL REFERENCES project_approval(id),
  session_id TEXT UNIQUE,
  epic_id TEXT,
  released_at INTEGER,
  PRIMARY KEY(approval_id, issue_id)
) STRICT;
INSERT INTO project_approval_issue_delegation (
  workspace_id, issue_id, approval_id, session_id, epic_id, released_at
)
SELECT workspace_id, issue_id, approval_id, session_id, epic_id, released_at
FROM project_approval_issue;
DROP TABLE project_approval_issue;
ALTER TABLE project_approval_issue_delegation RENAME TO project_approval_issue;
CREATE UNIQUE INDEX project_approval_issue_active ON project_approval_issue(workspace_id, issue_id) WHERE released_at IS NULL;
`,
  },
  {
    id: "065_drop_epic",
    sql: `
UPDATE work_item SET brief=json_set(work_item.brief,
  '$.epic', json_object(
    'source','linear','issueId',e.linear_issue_id,'identifier',e.linear_identifier,
    'title',e.title,'description',NULL,'acceptanceCriteria',NULL))
FROM epic e
WHERE e.id=work_item.epic_id AND e.linear_issue_id<>work_item.linear_issue_id
AND work_item.brief IS NOT NULL AND json_extract(work_item.brief,'$.epic.issueId') IS NULL;
ALTER TABLE work_item RENAME COLUMN epic_id TO delegation_id;
ALTER TABLE project_approval_issue RENAME COLUMN epic_id TO delegation_id;
DROP INDEX work_item_epic_position;
CREATE INDEX work_item_delegation_position ON work_item (delegation_id, position);
DROP TABLE epic_dependency_snapshot;
DROP TABLE epic_reconciliation_request;
DROP TABLE epic_reconciliation_effect;
DROP TABLE external_blocker_policy;
DROP TABLE epic;
`,
  },
  {
    id: "066_repository_catalog",
    sql: `
CREATE TABLE repository_catalog (
  repository TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  remote_url TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  refreshed_at INTEGER NOT NULL
) STRICT;
`,
  },
  {
    id: "067_pull_request_draft",
    sql: `
CREATE TABLE pull_request_draft (
  item_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`,
  },
  {
    id: "068_release_stopped_parent_issues",
    sql: `
UPDATE project_approval_issue SET released_at = (
  SELECT a.stopped_at FROM project_approval a WHERE a.id = project_approval_issue.approval_id
) WHERE released_at IS NULL AND approval_id IN (
  SELECT id FROM project_approval WHERE source = 'parent' AND stopped_at IS NOT NULL
);
`,
  },
  {
    id: "069_runner_host_status",
    sql: `
CREATE TABLE runner_host_status (
  runner_id TEXT PRIMARY KEY REFERENCES runner(id),
  cpu_percent REAL CHECK(cpu_percent BETWEEN 0 AND 100),
  memory_total_bytes INTEGER CHECK(memory_total_bytes>=0),
  memory_available_bytes INTEGER CHECK(memory_available_bytes>=0),
  load_1 REAL CHECK(load_1>=0),
  load_5 REAL CHECK(load_5>=0),
  load_15 REAL CHECK(load_15>=0),
  disk_total_bytes INTEGER CHECK(disk_total_bytes>=0),
  disk_free_bytes INTEGER CHECK(disk_free_bytes>=0),
  os_id TEXT,
  os_version TEXT,
  runner_version TEXT,
  reported_at INTEGER NOT NULL
) STRICT;
`,
  },
  {
    id: "070_drop_runner_seat",
    sql: `
ALTER TABLE runner_agent_policy DROP COLUMN seat;
ALTER TABLE runner_execution_usage DROP COLUMN seat;
DROP TABLE workspace_runner_policy;
`,
  },
  {
    id: "071_evidence",
    sql: `
CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  run_id TEXT NOT NULL REFERENCES run(id),
  check_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt >= 1),
  media_type TEXT NOT NULL
    CHECK(media_type IN ('video/webm','video/mp4','image/png','image/jpeg','image/webp')),
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  display_name TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX evidence_item ON evidence (item_id, created_at);
`,
  },
];
