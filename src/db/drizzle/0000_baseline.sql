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
, recurring_every_ms INTEGER, fire_count INTEGER NOT NULL DEFAULT 0, lane TEXT NOT NULL DEFAULT 'default', item_version INTEGER, activation_id INTEGER NOT NULL DEFAULT 0) STRICT;
--> statement-breakpoint
CREATE TABLE workspace_user (
  id TEXT PRIMARY KEY,
  linear_user_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE "work_item" (
  id TEXT PRIMARY KEY,
  delegation_id TEXT NOT NULL,
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
    'failed',
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
  delegated_by TEXT,
  resumed_at INTEGER,
  accepted_head TEXT,
  agent_ms INTEGER NOT NULL DEFAULT 0,
  closeout_ms INTEGER NOT NULL DEFAULT 0,
  waiting_ms INTEGER NOT NULL DEFAULT 0,
  recheck_ms INTEGER NOT NULL DEFAULT 0,
  linear_project_id TEXT,
  linear_project_name TEXT
, implement_ms INTEGER NOT NULL DEFAULT 0, fix_ms INTEGER NOT NULL DEFAULT 0, max_fix_ms INTEGER NOT NULL DEFAULT 0, max_closeout_ms INTEGER NOT NULL DEFAULT 0) STRICT;
--> statement-breakpoint
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
--> statement-breakpoint
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
, locked_by TEXT, locked_until INTEGER, max_attempts INTEGER NOT NULL DEFAULT 5, delivery_kind TEXT NOT NULL DEFAULT 'ordered'
  CHECK (delivery_kind IN ('ordered', 'progress', 'critical', 'terminal', 'stop', 'status')), delivery_generation INTEGER NOT NULL DEFAULT 0, activity_run_id TEXT REFERENCES run(id)) STRICT;
--> statement-breakpoint
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
, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, last_error TEXT) STRICT;
--> statement-breakpoint
CREATE TABLE sync_cursor (
  name TEXT PRIMARY KEY,
  cursor_ms INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE wake (
  from_wall INTEGER PRIMARY KEY,
  to_wall INTEGER NOT NULL,
  slept_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
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
, recheck_digest TEXT) STRICT;
--> statement-breakpoint
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
  ordinal INTEGER NOT NULL, duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0), tokens INTEGER CHECK (tokens IS NULL OR tokens >= 0), review_fail_on TEXT CHECK (review_fail_on IS NULL OR review_fail_on IN ('P0', 'P1', 'P2', 'P3')), review_pre_existing TEXT,
  PRIMARY KEY (progress_id, step_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE "question" (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  run_id TEXT,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'agent',
  body TEXT NOT NULL,
  context TEXT,
  options TEXT CHECK (options IS NULL OR json_valid(options)),
  status TEXT NOT NULL CHECK (status IN ('queued', 'open', 'answered')),
  answer TEXT,
  answered_by TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER,
  cancelled_at INTEGER,
  answer_event_key TEXT
, reason TEXT, handoff_version INTEGER) STRICT;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE outbox_session_fence (
  target TEXT NOT NULL,
  ordering_key TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  stopped INTEGER NOT NULL DEFAULT 0 CHECK (stopped IN (0, 1)),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (target, ordering_key)
) STRICT;
--> statement-breakpoint
CREATE TABLE github_delivery (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  received_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE linear_session_context (
  session_id TEXT PRIMARY KEY,
  context TEXT NOT NULL,
  richness INTEGER NOT NULL,
  snapshot_context TEXT
) STRICT;
--> statement-breakpoint
CREATE TABLE linear_activity_snapshot (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot))
) STRICT;
--> statement-breakpoint
CREATE TABLE linear_session (
  session_id TEXT PRIMARY KEY,
  issue_id TEXT,
  organization_id TEXT,
  app_user_id TEXT,
  creator_id TEXT,
  active_item_id TEXT REFERENCES work_item(id),
  generation INTEGER NOT NULL DEFAULT 0,
  stopped_at INTEGER,
  created_at INTEGER NOT NULL
, oauth_client_id TEXT, team_id TEXT, installation_observed_at INTEGER) STRICT;
--> statement-breakpoint
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
, announced_generation INTEGER) STRICT;
--> statement-breakpoint
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
  created_at INTEGER NOT NULL, identity_hash TEXT,
  UNIQUE(item_id, path, display_name, mime_type, sha256)
) STRICT;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE task_request (
  task_key TEXT PRIMARY KEY,
  classification TEXT NOT NULL CHECK (json_valid(classification))
) STRICT;
--> statement-breakpoint
CREATE TABLE linear_conversation (
      item_id TEXT PRIMARY KEY REFERENCES work_item(id),
      entries TEXT NOT NULL CHECK(json_valid(entries)),
      transcript TEXT,
      transcript_offset INTEGER NOT NULL DEFAULT 0,
      blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1))
    , blocked_at INTEGER) STRICT;
--> statement-breakpoint
CREATE TABLE linear_stop_receipt (
      session_id TEXT NOT NULL REFERENCES linear_session(session_id),
      event_key TEXT NOT NULL,
      generation INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(session_id,event_key)
    ) STRICT;
--> statement-breakpoint
CREATE TABLE linear_session_cleanup_block (
      session_id TEXT PRIMARY KEY REFERENCES linear_session(session_id)
    ) STRICT;
--> statement-breakpoint
CREATE TABLE work_item_repository (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  remote_url TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE work_item_repository_question (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  question_id TEXT NOT NULL REFERENCES question(id),
  candidates TEXT NOT NULL CHECK (json_valid(candidates))
, chosen_repository TEXT CHECK(chosen_repository IS NULL OR json_valid(chosen_repository))) STRICT;
--> statement-breakpoint
CREATE TABLE linear_artifact_attempt (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  identity_hash TEXT NOT NULL,
  version INTEGER NOT NULL,
  completed_version INTEGER NOT NULL DEFAULT 0, attachment_requested INTEGER NOT NULL DEFAULT 0 CHECK (attachment_requested IN (0, 1)),
  PRIMARY KEY(item_id, identity_hash)
) STRICT;
--> statement-breakpoint
CREATE TABLE linear_app_revocation (
  organization_id TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL,
  revoked_at INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 1, restored_after INTEGER, restored_credential_fingerprint TEXT,
  PRIMARY KEY (organization_id, oauth_client_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE linear_team_access (
  organization_id TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL,
  app_user_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, oauth_client_id, app_user_id, team_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE linear_installation_permission (
  organization_id TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL,
  app_user_id TEXT NOT NULL,
  all_public_teams INTEGER NOT NULL CHECK (all_public_teams IN (0, 1)),
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (organization_id, oauth_client_id, app_user_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE linear_access_event (
  event_key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE linear_task_delegation (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  issue_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  app_user_id TEXT NOT NULL,
  human_actor_id TEXT,
  PRIMARY KEY (item_id, issue_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE remote_merge_fact (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  repository_owner TEXT NOT NULL CHECK (length(repository_owner) > 0),
  repository_name TEXT NOT NULL CHECK (length(repository_name) > 0),
  pull_number INTEGER NOT NULL CHECK (pull_number > 0),
  pull_url TEXT,
  merge_sha TEXT,
  confirmed_at INTEGER NOT NULL CHECK (confirmed_at >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE linear_issue_context (
  session_id TEXT NOT NULL REFERENCES linear_session(session_id),
  issue_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  context TEXT NOT NULL,
  PRIMARY KEY (session_id,issue_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE workspace (
  id TEXT PRIMARY KEY,
  linear_organization_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE workspace_member (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  user_id TEXT NOT NULL REFERENCES workspace_user(id),
  role TEXT NOT NULL CHECK(role IN ('owner','admin','member','observer')),
  source TEXT NOT NULL CHECK(source IN ('linear','manual')),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  checked_at INTEGER NOT NULL, manual_role TEXT
      CHECK(manual_role IN ('owner','admin','member','observer')), revoked_at INTEGER, revoked_by TEXT REFERENCES workspace_user(id),
  PRIMARY KEY(workspace_id,user_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE workspace_user_team (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,user_id,team_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_member(workspace_id,user_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE workspace_repository (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  repository TEXT NOT NULL,
  team_id TEXT NOT NULL,
  PRIMARY KEY(workspace_id,repository,team_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE workspace_session (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES workspace_user(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  csrf_token TEXT NOT NULL,
  authenticated_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE workspace_bootstrap (
  token_hash TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
) STRICT;
--> statement-breakpoint
CREATE TABLE workspace_oauth_request (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  bootstrap_hash TEXT,
  expires_at INTEGER NOT NULL
, assignment_hash TEXT) STRICT;
--> statement-breakpoint
CREATE TABLE workspace_access_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT REFERENCES workspace(id),
  user_id TEXT REFERENCES workspace_user(id),
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE runner (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','paused','draining','revoked')),
  fence INTEGER NOT NULL DEFAULT 0 CHECK(fence >= 0),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER, last_seen_at INTEGER, live_reported_at INTEGER, terminations_since INTEGER,
  FOREIGN KEY(workspace_id,owner_user_id) REFERENCES workspace_member(workspace_id,user_id)
) STRICT;
--> statement-breakpoint
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
--> statement-breakpoint
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
, consumed_sequence INTEGER NOT NULL DEFAULT 0 CHECK(consumed_sequence>=0), confirmed_at INTEGER, lost_at INTEGER, teardown_confirmed_at INTEGER) STRICT;
--> statement-breakpoint
CREATE TABLE runner_work_grant (
  token_hash TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runner_work(run_id),
  generation INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE runner_event (
  run_id TEXT NOT NULL REFERENCES runner_work(run_id),
  generation INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  received_at INTEGER NOT NULL, key_id TEXT, payload_sha256 TEXT, type TEXT, handed_over INTEGER, reason TEXT,
  PRIMARY KEY(run_id,generation,sequence)
) STRICT;
--> statement-breakpoint
CREATE TABLE "runner_command" (
  ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  runner_id TEXT NOT NULL REFERENCES runner(id),
  run_id TEXT REFERENCES run(id),
  generation INTEGER,
  kind TEXT NOT NULL CHECK(kind IN ('run','review','check','task','cancel','handover','checkpoint','probe','login_check','login','upgrade')),
  envelope TEXT NOT NULL CHECK(json_valid(envelope)),
  expires_at INTEGER NOT NULL,
  acknowledged_at INTEGER
) STRICT;
--> statement-breakpoint
CREATE TABLE runner_result (
  run_id TEXT NOT NULL REFERENCES runner_work(run_id),
  generation INTEGER NOT NULL CHECK(generation>0),
  command_id TEXT NOT NULL REFERENCES runner_command(id),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  received_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,generation)
) STRICT;
--> statement-breakpoint
CREATE TABLE runner_question_answer (
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  answer TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,generation,sequence),
  FOREIGN KEY(run_id,generation,sequence) REFERENCES runner_event(run_id,generation,sequence)
) STRICT;
--> statement-breakpoint
CREATE TABLE runner_health_result (
  command_id TEXT PRIMARY KEY REFERENCES runner_command(id),
  runner_id TEXT NOT NULL REFERENCES runner(id),
  result_json TEXT NOT NULL,
  received_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE runner_transcript_chunk (
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  offset INTEGER NOT NULL CHECK(offset>=0),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 524288),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64), key_id TEXT
CHECK(key_id IS NULL OR length(key_id)=64),
  PRIMARY KEY(run_id,generation,offset),
  FOREIGN KEY(run_id,generation) REFERENCES runner_transcript(run_id,generation)
) STRICT;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE work_item_scheduling (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  project_id TEXT,
  project_known INTEGER NOT NULL CHECK(project_known IN (0,1)),
  priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 4),
  paths TEXT CHECK(paths IS NULL OR json_valid(paths))
, project_lead_id TEXT) STRICT;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE runner_policy (
 runner_id TEXT PRIMARY KEY REFERENCES runner(id),
 host_owner TEXT NOT NULL DEFAULT 'unknown' CHECK(host_owner IN ('member','workspace','unknown')),
 sharing INTEGER NOT NULL DEFAULT 0 CHECK(sharing IN (0,1)),
 fallback INTEGER NOT NULL DEFAULT 0 CHECK(fallback IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE work_item_specification (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  hash TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  present INTEGER NOT NULL CHECK(present IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE linear_outbox_backoff (
 id INTEGER PRIMARY KEY CHECK(id=1),
 not_before INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE workspace_assignment (
 session_id TEXT NOT NULL REFERENCES linear_session(session_id),
 generation INTEGER NOT NULL,
 workspace_id TEXT NOT NULL REFERENCES workspace(id),
 actor_id TEXT NOT NULL,
 token_hash TEXT NOT NULL UNIQUE,
 fingerprint TEXT NOT NULL,
 event TEXT NOT NULL CHECK(json_valid(event)),
 expires_at INTEGER NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','ready','accepted','continued','invalid')), link_id TEXT, link_expires_at INTEGER, completed_at INTEGER,
 PRIMARY KEY(session_id,generation)
) STRICT;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE workspace_github_connection (
 workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
 generation INTEGER NOT NULL DEFAULT 0,
 secret_id TEXT,
 actor_id TEXT REFERENCES workspace_user(id),
 installation_id TEXT,
 repositories TEXT NOT NULL DEFAULT '[]'
) STRICT;
--> statement-breakpoint
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
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE github_attribution_request (
 state_hash TEXT PRIMARY KEY,
 browser_hash TEXT NOT NULL,
 session_hash TEXT NOT NULL REFERENCES workspace_session(token_hash) ON DELETE CASCADE,
 workspace_id TEXT NOT NULL REFERENCES workspace(id),
 user_id TEXT NOT NULL REFERENCES workspace_user(id),
 revision INTEGER NOT NULL,
 expires_at INTEGER NOT NULL
, return_path TEXT CHECK (
  return_path IS NULL OR return_path = '/status/settings/account' OR (
    length(return_path) = 35 AND substr(return_path, 1, 9) = '/onboard/'
    AND substr(return_path, 10) NOT GLOB '*[^0-9A-Za-z]*'
  )
)) STRICT;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE VIRTUAL TABLE decision_memory_search USING fts5(decision_id UNINDEXED, statement, tags);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE runner_capacity (
 runner_id TEXT PRIMARY KEY REFERENCES runner(id),
 capacity INTEGER NOT NULL CHECK(capacity BETWEEN 1 AND 16)
, ceiling INTEGER CHECK(ceiling IS NULL OR ceiling BETWEEN 1 AND 16), desired INTEGER CHECK(desired IS NULL OR desired BETWEEN 1 AND 16)) STRICT;
--> statement-breakpoint
CREATE TABLE task_block (
 blocker_linear_issue_id TEXT NOT NULL,
 blocked_linear_issue_id TEXT NOT NULL,
 PRIMARY KEY(blocked_linear_issue_id,blocker_linear_issue_id),
 CHECK(blocker_linear_issue_id <> blocked_linear_issue_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE item_dependency_snapshot (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  generation INTEGER NOT NULL CHECK(generation>0),
  scope TEXT NOT NULL CHECK(json_valid(scope)),
  linear_states TEXT NOT NULL CHECK(json_valid(linear_states)),
  external_evidence TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(external_evidence))
, linear_identifiers TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(linear_identifiers))) STRICT;
--> statement-breakpoint
CREATE TABLE item_reconciliation_request (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  token TEXT NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE item_reconciliation_effect (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  kind TEXT NOT NULL CHECK(kind IN ('spec','removed','canceled')),
  token TEXT NOT NULL,
  PRIMARY KEY(item_id,kind)
) STRICT;
--> statement-breakpoint
CREATE TABLE repository_catalog (
  repository TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  remote_url TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  refreshed_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE pull_request_draft (
  item_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
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
, cpu_count INTEGER CHECK(cpu_count>=1), stray_processes TEXT, mise_version TEXT, agent_user TEXT CHECK(agent_user IN ('runner','paws-agent'))) STRICT;
--> statement-breakpoint
CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  run_id TEXT NOT NULL,
  check_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt>=1),
  media_type TEXT NOT NULL CHECK(media_type IN ('video/webm','video/mp4','image/png','image/jpeg','image/webp')),
  size_bytes INTEGER NOT NULL CHECK(size_bytes>0),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  display_name TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  created_at INTEGER NOT NULL
, asset_url TEXT) STRICT;
--> statement-breakpoint
CREATE TABLE runner_follow_up (
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence>0),
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(run_id,generation,sequence)
) STRICT;
--> statement-breakpoint
CREATE TABLE browser_installation_request (
 state_hash TEXT PRIMARY KEY,
 browser_hash TEXT NOT NULL,
 identity TEXT NOT NULL,
 expires_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE agent_closeout_event (
  run_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  item_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('report', 'started', 'finished')),
  head TEXT NOT NULL,
  max_attempts INTEGER,
  check_id TEXT,
  kind TEXT,
  command TEXT,
  attempt INTEGER,
  state TEXT CHECK(state IS NULL OR state IN ('passed', 'failed', 'exhausted', 'cancelled')),
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0 CHECK(timed_out IN (0, 1)),
  duration_ms INTEGER,
  stdout TEXT NOT NULL DEFAULT '',
  stderr TEXT NOT NULL DEFAULT '',
  truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0, 1)),
  checks TEXT,
  blocked TEXT, base TEXT, policy_digest TEXT, clean INTEGER CHECK(clean IS NULL OR clean IN (0, 1)),
  PRIMARY KEY (run_id, sequence)
) STRICT;
--> statement-breakpoint
CREATE TABLE closeout_round (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  head TEXT NOT NULL,
  retry_baseline TEXT NOT NULL CHECK (json_valid(retry_baseline)),
  started_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, head)
) STRICT;
--> statement-breakpoint
CREATE TABLE queue_wait (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  version INTEGER NOT NULL,
  since INTEGER NOT NULL,
  PRIMARY KEY (item_id, version)
) STRICT;
--> statement-breakpoint
CREATE TABLE usage_pause (
  run_id TEXT PRIMARY KEY REFERENCES run(id),
  item_id TEXT NOT NULL REFERENCES work_item(id),
  agent TEXT NOT NULL,
  runner_id TEXT,
  resets_at INTEGER,
  resume_at INTEGER NOT NULL,
  paused_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE agent_skill (
  name TEXT PRIMARY KEY CHECK(length(name) BETWEEN 1 AND 64),
  source TEXT NOT NULL CHECK(json_valid(source)),
  version TEXT NOT NULL CHECK(length(version) BETWEEN 1 AND 128),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  size_bytes INTEGER NOT NULL CHECK(size_bytes>0),
  agents TEXT NOT NULL CHECK(json_valid(agents)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  removed_at INTEGER
) STRICT;
--> statement-breakpoint
CREATE TABLE queue_position (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  position INTEGER NOT NULL CHECK (position >= 1),
  busy_slots INTEGER NOT NULL CHECK (busy_slots >= 0),
  total_slots INTEGER NOT NULL CHECK (total_slots >= 1),
  updated_at INTEGER NOT NULL
, owner_cap INTEGER CHECK (owner_cap IS NULL OR owner_cap >= 1)) STRICT;
--> statement-breakpoint
CREATE TABLE work_item_merge_settings (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  merge_order TEXT NOT NULL CHECK(merge_order IN ('queue','ci-green','github-queue')),
  main_moved TEXT NOT NULL CHECK(main_moved IN ('overlap','ci','closeout')),
  resolved_json TEXT NOT NULL,
  resolved_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE merge_queue_entry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL UNIQUE REFERENCES work_item(id),
  repository TEXT NOT NULL,
  ready_at INTEGER NOT NULL,
  notified_position INTEGER
, kept INTEGER NOT NULL DEFAULT 0 CHECK (kept IN (0, 1)), lane TEXT NOT NULL DEFAULT '') STRICT;
--> statement-breakpoint
CREATE TABLE "runner_agent_usage" (
  runner_id TEXT NOT NULL REFERENCES runner(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  limits_json TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  PRIMARY KEY (runner_id, agent)
) STRICT;
--> statement-breakpoint
CREATE TABLE ci_round (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  head TEXT NOT NULL,
  run_id TEXT,
  next TEXT NOT NULL CHECK(next IN ('agent','asked','failed')),
  fix INTEGER CHECK(fix IS NULL OR fix >= 1),
  fix_limit INTEGER NOT NULL CHECK(fix_limit >= 0),
  checks TEXT NOT NULL CHECK(json_valid(checks)),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, head)
) STRICT;
--> statement-breakpoint
CREATE TABLE work_item_linear_read (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  kind TEXT NOT NULL CHECK(kind IN ('project_overview','repository_hints','repository_suggestions')),
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  read_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, kind)
) STRICT;
--> statement-breakpoint
CREATE TABLE linear_activity_listing (
  session_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE runner_skill (
  runner_id TEXT NOT NULL REFERENCES runner(id),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('installed','pending','refused')),
  reported_at INTEGER NOT NULL, error TEXT, waiting INTEGER,
  PRIMARY KEY (runner_id, name)
) STRICT;
--> statement-breakpoint
CREATE TABLE delegation_reconciliation (
  delegation_id TEXT PRIMARY KEY,
  changes INTEGER NOT NULL DEFAULT 0,
  reconciled_changes INTEGER NOT NULL DEFAULT 0,
  reconciled_at INTEGER
) STRICT;
--> statement-breakpoint
CREATE TABLE visual_review (
  question_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  check_id TEXT NOT NULL,
  evidence_ids TEXT NOT NULL CHECK(json_valid(evidence_ids)),
  created_at INTEGER NOT NULL
, kind TEXT NOT NULL DEFAULT 'review' CHECK(kind IN ('review','continue')), outcome TEXT CHECK(outcome IS NULL OR outcome IN ('accepted','changes_requested','stale','continued')), answered_by TEXT, answered_at INTEGER, feedback TEXT, head_commit TEXT, carried TEXT CHECK(carried IS NULL OR json_valid(carried))) STRICT;
--> statement-breakpoint
CREATE TABLE linear_item_request (
  item_id TEXT PRIMARY KEY,
  requests INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE visual_review_mark (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES visual_review(question_id),
  evidence_id TEXT NOT NULL REFERENCES evidence(id),
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE run_agent_setup (
  run_id TEXT PRIMARY KEY REFERENCES run(id),
  runner_id TEXT NOT NULL REFERENCES runner(id),
  skills TEXT NOT NULL,
  hooks TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE "agent_hook" (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL CHECK(event IN ('after_edit','before_shell','before_tool','stop','session_start')),
  matcher TEXT CHECK(matcher IS NULL OR length(matcher) BETWEEN 1 AND 256),
  command TEXT NOT NULL CHECK(length(command) BETWEEN 1 AND 4096),
  timeout_seconds INTEGER NOT NULL CHECK(timeout_seconds BETWEEN 1 AND 600),
  agents TEXT NOT NULL CHECK(json_valid(agents)),
  skill TEXT,
  created_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE linear_item_caller_request (
  item_id TEXT NOT NULL,
  caller TEXT NOT NULL,
  requests INTEGER NOT NULL,
  PRIMARY KEY (item_id, caller)
) STRICT;
--> statement-breakpoint
CREATE TABLE runner_runtime (
  runner_id TEXT NOT NULL REFERENCES runner(id),
  tool TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('installed','failed')),
  error TEXT,
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (runner_id, tool, version)
) STRICT;
--> statement-breakpoint
CREATE TABLE parent_delegation (
  delegation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  organization_id TEXT NOT NULL,
  parent_issue_id TEXT NOT NULL,
  parent_identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  session_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES workspace_user(id),
  edges TEXT NOT NULL CHECK (json_valid(edges)),
  created_at INTEGER NOT NULL,
  stopped_at INTEGER,
  last_error TEXT
) STRICT;
--> statement-breakpoint
CREATE TABLE parent_delegation_issue (
  parent_delegation_id TEXT NOT NULL REFERENCES parent_delegation(delegation_id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  issue_id TEXT NOT NULL,
  identifier TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  position INTEGER NOT NULL,
  session_id TEXT UNIQUE,
  delegation_id TEXT,
  released_at INTEGER,
  PRIMARY KEY (parent_delegation_id, issue_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE npm_package (
  package TEXT PRIMARY KEY,
  etag TEXT,
  fetched_at INTEGER NOT NULL,
  versions TEXT NOT NULL CHECK (json_valid(versions))
) STRICT;
--> statement-breakpoint
CREATE TABLE npm_package_version (
  package TEXT NOT NULL,
  version TEXT NOT NULL,
  integrity TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  changed_integrity TEXT,
  changed_at INTEGER,
  PRIMARY KEY (package, version)
) STRICT;
--> statement-breakpoint
CREATE TABLE agent_version (
  agent TEXT NOT NULL,
  version TEXT NOT NULL,
  published_at INTEGER,
  integrity TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('eligible','waiting','ineligible','refused')),
  first_seen_at INTEGER NOT NULL,
  reason TEXT,
  native_version TEXT,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (agent, version)
) STRICT;
--> statement-breakpoint
CREATE TABLE agent_catalog_refresh (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  completed_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE runner_agent (
  runner_id TEXT NOT NULL REFERENCES runner(id),
  agent TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('current','previous','installing','waiting','failed')),
  error TEXT,
  sessions INTEGER,
  target_id TEXT,
  reported_at INTEGER NOT NULL,
  PRIMARY KEY (runner_id, agent, status)
) STRICT;
--> statement-breakpoint
CREATE TABLE "runner_agent_target" (
  runner_id TEXT NOT NULL REFERENCES runner(id),
  agent TEXT NOT NULL,
  id TEXT NOT NULL,
  version TEXT NOT NULL,
  integrity TEXT NOT NULL,
  native_version TEXT,
  packages TEXT NOT NULL CHECK (json_valid(packages) AND json_array_length(packages) > 0),
  requested_by TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  PRIMARY KEY (runner_id, agent)
) STRICT;
--> statement-breakpoint
CREATE TABLE runner_enrollment (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  runner_id TEXT REFERENCES runner(id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_member(workspace_id,user_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE member_vm (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  vm_name TEXT NOT NULL UNIQUE,
  step TEXT NOT NULL CHECK(step IN ('create','install','enroll','health','ready')),
  failure TEXT,
  runner_id TEXT REFERENCES runner(id),
  step_started_at INTEGER NOT NULL,
  create_requested_at INTEGER,
  install_started_at INTEGER,
  token_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, install_at INTEGER, enroll_at INTEGER, health_at INTEGER, ready_at INTEGER, delete_step TEXT
  CHECK(delete_step IS NULL OR delete_step IN ('drain','tailnet','revoke','destroy','clear')), delete_runner_id TEXT, delete_requested_by TEXT, delete_force INTEGER NOT NULL DEFAULT 0 CHECK(delete_force IN (0,1)), delete_step_started_at INTEGER, delete_at TEXT CHECK(delete_at IS NULL OR json_valid(delete_at)), delete_failure TEXT, delete_blocked TEXT
  CHECK(delete_blocked IS NULL OR json_valid(delete_blocked)), enrollments_tracked INTEGER NOT NULL DEFAULT 1
  CHECK(enrollments_tracked IN (0,1)), pool TEXT,
  UNIQUE(workspace_id,user_id),
  FOREIGN KEY(workspace_id,user_id) REFERENCES workspace_member(workspace_id,user_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE runner_setup_hold (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  owner_user_id TEXT REFERENCES workspace_user(id),
  reason TEXT NOT NULL CHECK(reason IN ('no-runner','agent-not-signed-in')),
  runner_id TEXT,
  agent TEXT,
  since INTEGER NOT NULL,
  notified_at INTEGER
, run_id TEXT) STRICT;
--> statement-breakpoint
CREATE TABLE member_vm_enrollment (
  token_hash TEXT PRIMARY KEY,
  member_vm_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE runner_setup_resume (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  run_id TEXT NOT NULL REFERENCES run(id),
  released_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE work_item_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  version INTEGER NOT NULL,
  at INTEGER NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  event TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'transition' CHECK (kind IN ('transition','restart','ask')),
  reason TEXT,
  payload_digest TEXT,
  actor TEXT,
  CHECK (kind<>'restart'
    OR reason IN ('findings','ci','review','conflict','follow_up','answer')),
  CHECK (kind<>'ask' OR reason IS NOT NULL),
  UNIQUE (item_id, version)
) STRICT;
--> statement-breakpoint
CREATE TABLE agent_session_snapshot (
  run_id TEXT NOT NULL REFERENCES run(id),
  generation INTEGER NOT NULL CHECK(generation>0),
  item_id TEXT NOT NULL REFERENCES work_item(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  runner_id TEXT NOT NULL REFERENCES runner(id),
  owner_user_id TEXT REFERENCES workspace_user(id),
  agent TEXT CHECK(agent IS NULL OR agent IN ('claude','codex','grok')),
  agent_version TEXT,
  session_id TEXT,
  workspace_path TEXT,
  commit_sha TEXT,
  turn INTEGER CHECK(turn IS NULL OR turn>=0),
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes BETWEEN 0 AND 1073741824),
  sealed_size INTEGER CHECK(sealed_size IS NULL OR sealed_size=size_bytes),
  sha256 TEXT CHECK(sha256 IS NULL OR length(sha256)=64),
  status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','sealed','discarded')),
  created_at INTEGER NOT NULL,
  sealed_at INTEGER,
  CHECK(status<>'sealed' OR (owner_user_id IS NOT NULL AND agent IS NOT NULL
    AND agent_version IS NOT NULL AND session_id IS NOT NULL AND workspace_path IS NOT NULL
    AND commit_sha IS NOT NULL AND turn IS NOT NULL AND sealed_size IS NOT NULL
    AND sha256 IS NOT NULL AND sealed_at IS NOT NULL)),
  PRIMARY KEY(run_id,generation)
) STRICT;
--> statement-breakpoint
CREATE TABLE agent_session_snapshot_chunk (
  run_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  offset INTEGER NOT NULL CHECK(offset>=0 AND offset%524288=0),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 524288),
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  key_id TEXT NOT NULL CHECK(length(key_id)=64),
  PRIMARY KEY(run_id,generation,offset),
  FOREIGN KEY(run_id,generation) REFERENCES agent_session_snapshot(run_id,generation)
) STRICT;
--> statement-breakpoint
CREATE TABLE item_branch_state (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  run_id TEXT NOT NULL,
  head TEXT NOT NULL,
  base TEXT NOT NULL,
  commits INTEGER NOT NULL CHECK (commits >= 0),
  recorded_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE item_pull_request (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  pull_number INTEGER NOT NULL CHECK (pull_number > 0),
  pull_url TEXT,
  opened_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE item_wait (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  version INTEGER NOT NULL,
  since INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE pull_review (
  review_id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  state TEXT NOT NULL CHECK (state IN ('changes_requested','commented')),
  pull_number INTEGER NOT NULL CHECK (pull_number > 0),
  head TEXT,
  reviewer TEXT,
  body TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  handled_at INTEGER,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('restarted','asked','posted','dropped'))
) STRICT;
--> statement-breakpoint
CREATE TABLE "work_item_task" (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  mode TEXT NOT NULL CHECK (mode IN ('code', 'answer', 'artifact', 'plan')),
  response TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  repository_context INTEGER NOT NULL DEFAULT 0 CHECK(repository_context IN (0,1))
) STRICT;
--> statement-breakpoint
CREATE TABLE plan_proposal (
  question_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  parent_issue_id TEXT NOT NULL,
  repository TEXT,
  drafts TEXT NOT NULL CHECK (json_valid(drafts)),
  created_at INTEGER NOT NULL,
  filed TEXT CHECK (filed IS NULL OR json_valid(filed)),
  filed_at INTEGER
) STRICT;
--> statement-breakpoint
CREATE TABLE pull_comment (
  source TEXT NOT NULL CHECK (source IN ('review','inline','conversation')),
  comment_id INTEGER NOT NULL,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  pull_number INTEGER NOT NULL CHECK (pull_number > 0),
  review_id INTEGER,
  author TEXT,
  body TEXT NOT NULL,
  path TEXT,
  line INTEGER,
  received_at INTEGER NOT NULL,
  handled_at INTEGER,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('restarted','asked','dropped','covered')),
  PRIMARY KEY (source, comment_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE candidate_risk (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  head_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('high', 'normal')),
  paths TEXT NOT NULL CHECK (json_valid(paths)),
  classified_at INTEGER NOT NULL, matches TEXT CHECK (matches IS NULL OR json_valid(matches)),
  PRIMARY KEY (item_id, head_sha)
) STRICT;
--> statement-breakpoint
CREATE TABLE closeout_bypass_check (
  question_id TEXT NOT NULL REFERENCES question(id),
  check_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt INTEGER,
  message TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  reason TEXT,
  approved_by TEXT,
  approved_by_name TEXT,
  approved_at INTEGER,
  PRIMARY KEY (question_id, check_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE run_review_rounds (
  run_id TEXT PRIMARY KEY REFERENCES run(id),
  rounds INTEGER NOT NULL CHECK (rounds >= 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE merge_carried_accept (
  item_id TEXT NOT NULL,
  head TEXT NOT NULL,
  accepted_head TEXT NOT NULL,
  base TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, head)
) STRICT;
--> statement-breakpoint
CREATE TABLE review_escape (
  id INTEGER PRIMARY KEY,
  trigger_key TEXT NOT NULL UNIQUE,
  item_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('ci', 'review', 'comment')),
  accepted_head TEXT NOT NULL,
  pull_number INTEGER,
  detail TEXT NOT NULL CHECK (json_valid(detail)),
  recorded_at INTEGER NOT NULL,
  fix_head TEXT,
  files TEXT CHECK (files IS NULL OR json_valid(files)),
  is_escape INTEGER CHECK (is_escape IN (0, 1)),
  not_escape_reason TEXT CHECK (not_escape_reason IN ('flake', 'tests_docs_format', 'no_change', 'unreviewed')),
  settled_at INTEGER
) STRICT;
--> statement-breakpoint
CREATE TABLE runner_session_move (
  run_id TEXT PRIMARY KEY REFERENCES run(id),
  runner_id TEXT NOT NULL REFERENCES runner(id),
  requested_by TEXT,
  status TEXT NOT NULL CHECK(status IN ('moving','waiting','stayed')),
  reason TEXT,
  updated_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE "link_ask" (
  question_id TEXT PRIMARY KEY REFERENCES question(id),
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bypass', 'screenshots', 'risk', 'question', 'rounds', 'rule')),
  head_commit TEXT NOT NULL,
  link TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  answerers TEXT NOT NULL CHECK (json_valid(answerers)),
  created_at INTEGER NOT NULL,
  decision TEXT CHECK (decision IN ('approve', 'changes', 'answer', 'rethink', 'continue', 'stop')),
  note TEXT,
  decided_by TEXT,
  decided_at INTEGER,
  closed_reason TEXT CHECK (closed_reason IN ('decided', 'guidance', 'head_moved', 'cancelled')),
  closed_at INTEGER,
  rounds TEXT CHECK (rounds IS NULL OR json_valid(rounds))
) STRICT;
--> statement-breakpoint
CREATE TABLE risk_fix (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  head_sha TEXT NOT NULL,
  approved_head TEXT NOT NULL,
  approved_question_id TEXT NOT NULL,
  changed TEXT NOT NULL CHECK (json_valid(changed)),
  paths TEXT NOT NULL CHECK (json_valid(paths)),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, head_sha)
) STRICT;
--> statement-breakpoint
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
--> statement-breakpoint
CREATE TABLE paws_alive (
  id INTEGER PRIMARY KEY CHECK(id=1),
  at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE open_findings (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  head_sha TEXT NOT NULL,
  line TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE review_finding_issue (
  key TEXT PRIMARY KEY CHECK(length(key)=64),
  repository TEXT NOT NULL,
  path TEXT NOT NULL,
  lines TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  identifier TEXT NOT NULL,
  url TEXT,
  item_id TEXT,
  filed_by TEXT,
  filed_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE merge_call (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  head_sha TEXT NOT NULL,
  started_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE candidate_paths (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  head_sha TEXT NOT NULL,
  paths TEXT NOT NULL CHECK (json_valid(paths)),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, head_sha)
) STRICT;
--> statement-breakpoint
CREATE TABLE "item_hold" (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  reason TEXT NOT NULL CHECK (reason IN ('blocked','project','reconciling','snapshot','cap','slot','workspace','overlap')),
  blockers TEXT NOT NULL CHECK (json_valid(blockers)),
  files TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files))
) STRICT;
--> statement-breakpoint
CREATE TABLE item_continuation (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  previous_item_id TEXT NOT NULL REFERENCES work_item(id),
  branch TEXT NOT NULL CHECK (branch LIKE 'paws/%')
) STRICT;
--> statement-breakpoint
CREATE TABLE review_finding (
  id INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL,
  path TEXT NOT NULL,
  lines TEXT NOT NULL,
  first_line INTEGER,
  severity TEXT NOT NULL CHECK (severity IN ('P0', 'P1', 'P2', 'P3')),
  review TEXT NOT NULL,
  text TEXT NOT NULL,
  bug_class TEXT NOT NULL,
  why TEXT NOT NULL CHECK (why IN ('pre-existing', 'below failOn')),
  first_item_id TEXT NOT NULL REFERENCES work_item(id),
  first_head TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_item_id TEXT NOT NULL REFERENCES work_item(id),
  last_head TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filed', 'dismissed', 'gone')),
  status_by TEXT,
  status_at INTEGER,
  status_reason TEXT,
  filed_issue TEXT
) STRICT;
--> statement-breakpoint
CREATE TABLE review_finding_item (
  finding_id INTEGER NOT NULL REFERENCES review_finding(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  head_sha TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (finding_id, item_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE policy_runner_warning (
  repository TEXT PRIMARY KEY,
  policy_digest TEXT NOT NULL,
  runner_version TEXT NOT NULL,
  keys TEXT NOT NULL,
  checked_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE finding_group_run (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id),
 day TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
 fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
 tokens INTEGER, group_count INTEGER NOT NULL DEFAULT 0, error TEXT, finding_cursor INTEGER NOT NULL DEFAULT 0, issue_cursor INTEGER NOT NULL DEFAULT 0, skip_reason TEXT,
 UNIQUE(workspace_id, day)
) STRICT;
--> statement-breakpoint
CREATE TABLE finding_group (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id),
 repository TEXT NOT NULL, team_id TEXT NOT NULL, title TEXT NOT NULL,
 summary TEXT NOT NULL, scope TEXT NOT NULL, suggested_issue TEXT,
 member_ids TEXT NOT NULL CHECK(json_valid(member_ids)),
 created_at INTEGER NOT NULL, run_id TEXT NOT NULL REFERENCES finding_group_run(id),
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','filed','added','dismissed')),
 status_reason TEXT, status_by TEXT, status_at INTEGER, filed_issue TEXT,
 action TEXT CHECK(action IS NULL OR action IN ('file','add','dismiss'))
) STRICT;
--> statement-breakpoint
CREATE TABLE "agent_model_catalog" (
 runner_id TEXT NOT NULL REFERENCES runner(id),
 user_id TEXT NOT NULL REFERENCES workspace_user(id),
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex','grok','opencode')),
 model TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json)),
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(runner_id,user_id,agent,model)
) STRICT;
--> statement-breakpoint
CREATE TABLE "agent_model_probe" (
 command_id TEXT PRIMARY KEY REFERENCES runner_command(id),
 runner_id TEXT NOT NULL REFERENCES runner(id),
 user_id TEXT NOT NULL REFERENCES workspace_user(id),
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex','grok','opencode')),
 model TEXT NOT NULL,
 requested_at INTEGER NOT NULL,
 finished_at INTEGER
) STRICT;
--> statement-breakpoint
CREATE TABLE agent_account (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
 workspace_id TEXT NOT NULL REFERENCES workspace(id),
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex','grok','opencode')),
 label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
 legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1)),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 removed_at INTEGER, concurrency INTEGER CHECK(concurrency IS NULL OR concurrency BETWEEN 1 AND 64),
 UNIQUE(id,workspace_id,agent)
) STRICT;
--> statement-breakpoint
CREATE TABLE agent_account_binding (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
 workspace_id TEXT NOT NULL,
 account_id TEXT NOT NULL,
 agent TEXT NOT NULL,
 runner_id TEXT NOT NULL REFERENCES runner(id),
 legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1)),
 quota_scope TEXT NOT NULL CHECK(quota_scope IN ('account','unknown')),
 created_at INTEGER NOT NULL,
 removed_at INTEGER,
 FOREIGN KEY(account_id,workspace_id,agent) REFERENCES agent_account(id,workspace_id,agent),
 CHECK(legacy=0 OR quota_scope='unknown')
) STRICT;
--> statement-breakpoint
CREATE TABLE "runner_login" (
 id TEXT PRIMARY KEY REFERENCES runner_command(id),
 runner_id TEXT NOT NULL REFERENCES runner(id),
 workspace_id TEXT NOT NULL REFERENCES workspace(id),
 user_id TEXT NOT NULL REFERENCES workspace_user(id),
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex','grok','opencode')),
 state TEXT NOT NULL CHECK(state IN ('starting','waiting','connected','failed','cancelled','expired')),
 expires_at INTEGER NOT NULL,
 terminal TEXT NOT NULL DEFAULT '',
 authorization TEXT,
 input_id TEXT,
 updated_at INTEGER NOT NULL
, binding_id TEXT REFERENCES agent_account_binding(id)) STRICT;
--> statement-breakpoint
CREATE TABLE review_reply (
  id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL,
  restart_key TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number >= 1),
  pull_number INTEGER NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('thread', 'review', 'conversation')),
  comment_id INTEGER,
  thread_id TEXT,
  author TEXT,
  excerpt TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  outcome TEXT CHECK (outcome IN ('fixed', 'answered', 'not_changed', 'unreported')),
  reply TEXT,
  reported_at INTEGER,
  replied_at INTEGER,
  resolved_at INTEGER,
  UNIQUE (restart_key, number)
) STRICT;
--> statement-breakpoint
CREATE TABLE finding_grouping_off (
 workspace_id TEXT PRIMARY KEY REFERENCES workspace(id)
) STRICT;
--> statement-breakpoint
CREATE TABLE risk_auto_context (
    item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
    head TEXT NOT NULL,
    context TEXT NOT NULL,
    PRIMARY KEY (item_id, head)
  );
--> statement-breakpoint
CREATE TABLE runner_repositories (
    runner_id TEXT PRIMARY KEY REFERENCES runner(id) ON DELETE CASCADE,
    repositories TEXT CHECK (repositories IS NULL OR json_valid(repositories)),
    reported_at INTEGER NOT NULL
  , admin_repositories TEXT
    CHECK (admin_repositories IS NULL OR json_valid(admin_repositories))) STRICT;
--> statement-breakpoint
CREATE TABLE job_activation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE CASCADE
) STRICT;
--> statement-breakpoint
CREATE TABLE rebase_return (
  job_id INTEGER NOT NULL,
  activation_id INTEGER NOT NULL,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  candidate TEXT,
  reason TEXT NOT NULL CHECK(reason IN ('merge','github_queue','linear','push')),
  base TEXT,
  files TEXT CHECK(files IS NULL OR json_valid(files)),
  recorded_at INTEGER,
  PRIMARY KEY (job_id,activation_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE closeout_retry_window (
  job_id INTEGER NOT NULL REFERENCES job(id),
  activation_id INTEGER NOT NULL,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  retry_baseline TEXT NOT NULL CHECK(json_valid(retry_baseline)),
  PRIMARY KEY (job_id,activation_id)
);
--> statement-breakpoint
CREATE TABLE restart_hold (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE runner_command_account (
 command_id TEXT PRIMARY KEY,
 workspace_id TEXT NOT NULL,
 runner_id TEXT NOT NULL REFERENCES runner(id),
 agent TEXT NOT NULL,
 account_id TEXT NOT NULL,
 binding_id TEXT NOT NULL REFERENCES agent_account_binding(id),
 named INTEGER NOT NULL CHECK(named IN (0,1)),
 recorded_at INTEGER NOT NULL,
 FOREIGN KEY(account_id,workspace_id,agent) REFERENCES agent_account(id,workspace_id,agent)
) STRICT;
--> statement-breakpoint
CREATE TABLE runner_account_capability (
 runner_id TEXT PRIMARY KEY REFERENCES runner(id),
 protocol INTEGER NOT NULL CHECK(protocol>=1),
 bindings TEXT NOT NULL CHECK(json_valid(bindings)),
 reported_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE pull_ci_failure (
  item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
  head TEXT NOT NULL,
  pull_number INTEGER NOT NULL,
  item_version INTEGER NOT NULL,
  failed_checks TEXT NOT NULL CHECK(json_valid(failed_checks)),
  checks TEXT NOT NULL CHECK(json_valid(checks)),
  observed_at INTEGER NOT NULL,
  handled_at INTEGER,
  outcome TEXT CHECK(outcome IS NULL OR outcome IN ('restarted','asked','dropped','cleared')),
  PRIMARY KEY (item_id, head)
) STRICT;
--> statement-breakpoint
CREATE TABLE agent_account_health (
 kind TEXT NOT NULL CHECK(kind IN ('quota','auth','provider','model')),
 scope TEXT NOT NULL CHECK(scope IN ('account','binding','provider')),
 scope_id TEXT NOT NULL CHECK(length(scope_id) BETWEEN 1 AND 300),
 model TEXT NOT NULL DEFAULT '' CHECK(length(model)<=200),
 workspace_id TEXT NOT NULL REFERENCES workspace(id),
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex','grok','opencode')),
 state TEXT NOT NULL CHECK(state IN ('ok','low','exhausted','auth_required','restricted','unsupported_model')),
 source TEXT NOT NULL CHECK(source IN ('result','login_check','sign_in','resume')),
 source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 200),
 binding_id TEXT NOT NULL REFERENCES agent_account_binding(id),
 runner_id TEXT NOT NULL REFERENCES runner(id),
 observed_at INTEGER NOT NULL,
 resets_at INTEGER,
 next_check_at INTEGER,
 failures INTEGER NOT NULL DEFAULT 0 CHECK(failures BETWEEN 0 AND 1000),
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(kind,scope_id,model),
 CHECK((kind='provider')=(scope='provider')),
 CHECK(kind='model' OR model='')
) STRICT;
--> statement-breakpoint
CREATE TABLE run_fallback_attempt (
  run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL CHECK(length(call_id) BETWEEN 1 AND 300),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 256),
  policy_key TEXT NOT NULL CHECK(length(policy_key) BETWEEN 1 AND 2000),
  outcome TEXT NOT NULL CHECK(outcome IN ('failed','handed_over','usage_limit')),
  runner_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>=0),
  excluded_key TEXT NOT NULL CHECK(length(excluded_key)<=300),
  account_id TEXT,
  binding_id TEXT,
  recorded_at INTEGER NOT NULL,
  closed_at INTEGER,
  PRIMARY KEY(run_id,call_id,ordinal)
) STRICT;
--> statement-breakpoint
CREATE TABLE linear_comment (
  comment_id TEXT PRIMARY KEY CHECK(length(comment_id) BETWEEN 1 AND 300),
  issue_id TEXT NOT NULL CHECK(length(issue_id) BETWEEN 1 AND 300),
  organization_id TEXT,
  team_id TEXT,
  author_id TEXT,
  actor_id TEXT,
  actor_type TEXT,
  bot_actor TEXT,
  on_behalf_of TEXT,
  parent_id TEXT,
  body TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('webhook','poll')),
  edited INTEGER NOT NULL DEFAULT 0 CHECK(edited IN (0,1)),
  removed_at INTEGER,
  state TEXT NOT NULL DEFAULT 'received' CHECK(state IN
    ('received','queued','delivered','answered','ignored','rejected','removed')),
  reason TEXT,
  authority TEXT CHECK(authority IS NULL OR authority IN ('person','agent')),
  item_id TEXT,
  session_id TEXT,
  generation INTEGER,
  item_version INTEGER,
  via TEXT CHECK(via IS NULL OR via IN ('brief','follow_up','restart','answer')),
  settled_at INTEGER
) STRICT;
--> statement-breakpoint
CREATE TABLE ci_rerun (
  item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
  head_sha TEXT NOT NULL,
  run_ids TEXT NOT NULL CHECK(json_valid(run_ids)),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
  at INTEGER NOT NULL,
  PRIMARY KEY (item_id, head_sha)
) STRICT;
--> statement-breakpoint
CREATE TABLE retro_settings_revision (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  prompt TEXT NOT NULL CHECK(length(prompt) BETWEEN 1 AND 16000),
  agent_profile TEXT NOT NULL CHECK(json_valid(agent_profile)),
  repositories TEXT NOT NULL CHECK(json_valid(repositories) AND json_type(repositories) = 'array'),
  output_limits TEXT NOT NULL CHECK(json_valid(output_limits)),
  execution_limits TEXT NOT NULL CHECK(json_valid(execution_limits)),
  schedule TEXT NOT NULL CHECK(json_valid(schedule)),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, revision)
) STRICT;
--> statement-breakpoint
CREATE TABLE retro (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL CHECK(window_end > window_start),
  origin TEXT NOT NULL CHECK(origin IN ('scheduled','manual')),
  scheduled_for INTEGER,
  settings_revision INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  agent_profile TEXT NOT NULL CHECK(json_valid(agent_profile)),
  repositories TEXT NOT NULL CHECK(json_valid(repositories) AND json_type(repositories) = 'array'),
  output_limits TEXT NOT NULL CHECK(json_valid(output_limits)),
  execution_limits TEXT NOT NULL CHECK(json_valid(execution_limits)),
  state TEXT NOT NULL CHECK(state IN
    ('collecting','queued','generating','failed','published','abandoned','coverage_failed')),
  digest_sha256 TEXT CHECK(digest_sha256 IS NULL OR length(digest_sha256) = 64),
  manifest_sha256 TEXT CHECK(manifest_sha256 IS NULL OR length(manifest_sha256) = 64),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt >= 0),
  owner TEXT,
  owner_expires_at INTEGER,
  result TEXT CHECK(result IS NULL OR json_valid(result)),
  result_sha256 TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  published_at INTEGER,
  UNIQUE (workspace_id, window_start, window_end),
  FOREIGN KEY (workspace_id, settings_revision)
    REFERENCES retro_settings_revision(workspace_id, revision),
  CHECK(state IN ('collecting','abandoned','coverage_failed')
    OR (digest_sha256 IS NOT NULL AND manifest_sha256 IS NOT NULL)),
  CHECK(state <> 'published' OR (result IS NOT NULL AND result_sha256 IS NOT NULL))
) STRICT;
--> statement-breakpoint
CREATE TABLE retro_repository (
  retro_id TEXT NOT NULL REFERENCES retro(id),
  repository TEXT NOT NULL COLLATE NOCASE,
  start_cursor INTEGER NOT NULL,
  end_cursor INTEGER CHECK(end_cursor IS NULL OR end_cursor >= start_cursor),
  PRIMARY KEY (retro_id, repository)
) STRICT;
--> statement-breakpoint
CREATE TABLE retro_watermark (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  repository TEXT NOT NULL COLLATE NOCASE,
  cursor INTEGER NOT NULL,
  retro_id TEXT NOT NULL REFERENCES retro(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, repository)
) STRICT;
--> statement-breakpoint
CREATE TABLE retro_collection_lock (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  repository TEXT NOT NULL COLLATE NOCASE,
  retro_id TEXT NOT NULL REFERENCES retro(id),
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, repository)
) STRICT;
--> statement-breakpoint
CREATE TABLE retro_attempt (
  retro_id TEXT NOT NULL REFERENCES retro(id),
  attempt INTEGER NOT NULL CHECK(attempt >= 1),
  owner TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  lease_expires_at INTEGER NOT NULL,
  finished_at INTEGER,
  outcome TEXT NOT NULL CHECK(outcome IN ('running','failed','expired','succeeded')),
  error TEXT,
  PRIMARY KEY (retro_id, attempt)
) STRICT;
--> statement-breakpoint
CREATE TABLE retro_evidence (
  retro_id TEXT NOT NULL REFERENCES retro(id),
  evidence_id TEXT NOT NULL CHECK(length(evidence_id) BETWEEN 1 AND 200),
  repository TEXT NOT NULL COLLATE NOCASE,
  source_kind TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  excerpt TEXT NOT NULL CHECK(length(excerpt) <= 4000),
  PRIMARY KEY (retro_id, evidence_id)
) STRICT;
--> statement-breakpoint
CREATE TABLE retro_coverage_gap (
  id INTEGER PRIMARY KEY,
  retro_id TEXT NOT NULL REFERENCES retro(id),
  repository TEXT COLLATE NOCASE,
  kind TEXT NOT NULL CHECK(kind IN
    ('missing_artifact','hash_mismatch','retention_gap','source_unavailable')),
  detail TEXT NOT NULL CHECK(length(detail) BETWEEN 1 AND 2000),
  recorded_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE retro_artifact (
  retro_id TEXT NOT NULL REFERENCES retro(id),
  kind TEXT NOT NULL CHECK(kind IN ('digest','manifest','prompt','report')),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  file_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (retro_id, kind)
) STRICT;
--> statement-breakpoint
CREATE TABLE retro_schedule_runtime (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
  last_occurrence_at INTEGER,
  last_retro_id TEXT REFERENCES retro(id),
  next_due_at INTEGER,
  updated_at INTEGER NOT NULL
, blocked_reason TEXT, blocked_since INTEGER) STRICT;
--> statement-breakpoint
CREATE TABLE improvement (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  repository TEXT NOT NULL COLLATE NOCASE,
  created_at INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  review_state TEXT NOT NULL DEFAULT 'needs_review'
    CHECK(review_state IN ('needs_review','accepted','rejected')),
  reviewed_proposal INTEGER,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  review_reason TEXT,
  intent TEXT CHECK(intent IS NULL OR intent IN ('create','link')),
  intent_issue_id TEXT,
  evidence_comment INTEGER NOT NULL DEFAULT 0 CHECK(evidence_comment IN (0,1)),
  issue_id TEXT,
  issue_identifier TEXT,
  issue_url TEXT,
  issue_confirmed_at INTEGER,
  implementation_state TEXT NOT NULL DEFAULT 'unknown' CHECK(implementation_state IN
    ('unknown','not_started','in_progress','blocked','merged','completed','canceled','stale')),
  implementation_at INTEGER,
  verification_state TEXT NOT NULL DEFAULT 'unknown'
    CHECK(verification_state IN ('unknown','due','verified','contradicted')),
  verification_at INTEGER,
  CHECK(review_state <> 'accepted' OR (intent IS NOT NULL AND reviewed_proposal IS NOT NULL)),
  CHECK(review_state <> 'rejected' OR review_reason IS NOT NULL),
  CHECK(intent IS NOT 'link' OR intent_issue_id IS NOT NULL),
  CHECK(evidence_comment = 0 OR intent = 'link')
) STRICT;
--> statement-breakpoint
CREATE TABLE improvement_source (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('retro_item','daily_finding')),
  source_key TEXT NOT NULL CHECK(length(source_key) BETWEEN 1 AND 400),
  improvement_id TEXT NOT NULL REFERENCES improvement(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, source_kind, source_key)
) STRICT;
--> statement-breakpoint
CREATE TABLE improvement_proposal (
  improvement_id TEXT NOT NULL REFERENCES improvement(id),
  version INTEGER NOT NULL CHECK(version >= 1),
  source_kind TEXT NOT NULL,
  source_key TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 300),
  problem TEXT NOT NULL,
  proposed_change TEXT NOT NULL,
  action_step TEXT NOT NULL
    CHECK(action_step IN ('automatic','rule','convention','decision','issue')),
  verification_criterion TEXT NOT NULL,
  evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_type(evidence) = 'array'),
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256) = 64),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (improvement_id, version)
) STRICT;
--> statement-breakpoint
CREATE TABLE improvement_decision (
  improvement_id TEXT NOT NULL REFERENCES improvement(id),
  version INTEGER NOT NULL,
  review_state TEXT NOT NULL CHECK(review_state IN ('needs_review','accepted','rejected')),
  proposal_version INTEGER,
  intent TEXT,
  intent_issue_id TEXT,
  evidence_comment INTEGER NOT NULL CHECK(evidence_comment IN (0,1)),
  reason TEXT,
  actor TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (improvement_id, version)
) STRICT;
--> statement-breakpoint
CREATE TABLE retro_item (
  retro_id TEXT NOT NULL REFERENCES retro(id),
  item_id TEXT NOT NULL CHECK(length(item_id) BETWEEN 1 AND 100),
  position INTEGER NOT NULL CHECK(position >= 0),
  repository TEXT NOT NULL COLLATE NOCASE,
  area TEXT NOT NULL CHECK(length(area) BETWEEN 1 AND 200),
  action_step TEXT NOT NULL
    CHECK(action_step IN ('automatic','rule','convention','decision','issue')),
  title TEXT NOT NULL,
  problem TEXT NOT NULL,
  proposed_change TEXT NOT NULL,
  verification_criterion TEXT NOT NULL,
  evidence_ids TEXT NOT NULL CHECK(json_valid(evidence_ids) AND json_type(evidence_ids) = 'array'),
  improvement_id TEXT NOT NULL REFERENCES improvement(id),
  PRIMARY KEY (retro_id, item_id),
  UNIQUE (retro_id, position)
) STRICT;
--> statement-breakpoint
CREATE TABLE improvement_delivery (
  id TEXT PRIMARY KEY,
  improvement_id TEXT NOT NULL REFERENCES improvement(id),
  operation TEXT NOT NULL CHECK(operation IN ('create_issue','link_issue','evidence_comment')),
  target_issue_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','succeeded','failed','unknown')),
  claim_owner TEXT,
  claim_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  remote_id TEXT,
  remote_identifier TEXT,
  remote_url TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, target_team_id TEXT, content TEXT
  CHECK(content IS NULL OR json_valid(content)), next_attempt_at INTEGER, blocked TEXT
  CHECK(blocked IS NULL OR blocked IN ('destination','unauthorized','unavailable','conflict','attempts','workspace')), retry_base INTEGER NOT NULL DEFAULT 0,
  UNIQUE (improvement_id, operation),
  CHECK(operation = 'create_issue' OR target_issue_id IS NOT NULL),
  CHECK(state <> 'claimed' OR (claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL))
) STRICT;
--> statement-breakpoint
CREATE TABLE improvement_delivery_attempt (
  delivery_id TEXT NOT NULL REFERENCES improvement_delivery(id),
  attempt INTEGER NOT NULL CHECK(attempt >= 1),
  owner TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  claim_expires_at INTEGER NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'claimed'
    CHECK(outcome IN ('claimed','succeeded','failed','unknown','expired')),
  remote_id TEXT,
  remote_identifier TEXT,
  remote_url TEXT,
  error TEXT,
  settled_at INTEGER,
  PRIMARY KEY (delivery_id, attempt)
) STRICT;
--> statement-breakpoint
CREATE TABLE improvement_outcome (
  id INTEGER PRIMARY KEY,
  improvement_id TEXT NOT NULL REFERENCES improvement(id),
  track TEXT NOT NULL CHECK(track IN ('implementation','verification')),
  state TEXT NOT NULL,
  evidence TEXT NOT NULL CHECK(json_valid(evidence) AND json_type(evidence) = 'array'),
  revision TEXT,
  deployment TEXT,
  actor TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  CHECK(track <> 'verification' OR state <> 'verified' OR json_array_length(evidence) > 0)
) STRICT;
--> statement-breakpoint
CREATE TABLE retro_dispatch (
  command_id TEXT PRIMARY KEY,
  retro_id TEXT NOT NULL REFERENCES retro(id),
  attempt INTEGER NOT NULL CHECK(attempt >= 1),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  runner_id TEXT NOT NULL REFERENCES runner(id),
  runner_fence INTEGER NOT NULL,
  command TEXT NOT NULL CHECK(json_valid(command)),
  envelope TEXT NOT NULL CHECK(json_valid(envelope)),
  deliveries INTEGER NOT NULL DEFAULT 1 CHECK(deliveries >= 1),
  created_at INTEGER NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK(expires_at > issued_at),
  fetched_at INTEGER,
  acknowledged_at INTEGER,
  cancel_requested_at INTEGER,
  result TEXT CHECK(result IS NULL OR json_valid(result)),
  result_at INTEGER,
  released_at INTEGER,
  release_reason TEXT CHECK(release_reason IS NULL OR release_reason IN
    ('result','not_started','teardown')),
  settled_at INTEGER,
  UNIQUE (retro_id, attempt),
  CHECK((released_at IS NULL) = (release_reason IS NULL)),
  CHECK(result IS NULL OR release_reason = 'result')
) STRICT;
--> statement-breakpoint
CREATE TABLE retro_generation (
  retro_id TEXT PRIMARY KEY REFERENCES retro(id),
  diagnostic TEXT NOT NULL CHECK(diagnostic IN
    ('no_runner','capacity_wait','quota_cooldown','dispatched','active','unknown_outcome',
     'retry_backoff','failed','ready')),
  detail TEXT NOT NULL CHECK(length(detail) <= 2000),
  since INTEGER NOT NULL,
  until INTEGER,
  wait_ms INTEGER NOT NULL DEFAULT 0 CHECK(wait_ms >= 0),
  active_ms INTEGER NOT NULL DEFAULT 0 CHECK(active_ms >= 0),
  updated_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE retro_occurrence (
  retro_id TEXT PRIMARY KEY REFERENCES retro(id),
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  origin TEXT NOT NULL CHECK(origin IN ('scheduled','manual')),
  occurrence_at INTEGER NOT NULL,
  window_start INTEGER NOT NULL,
  window_end INTEGER NOT NULL CHECK(window_end > window_start),
  time_zone TEXT NOT NULL,
  local_date TEXT NOT NULL,
  local_time TEXT NOT NULL,
  utc_offset_minutes INTEGER NOT NULL,
  local_adjustment TEXT NOT NULL CHECK(local_adjustment IN ('exact','skipped_forward','repeated_first')),
  settings_revision INTEGER NOT NULL,
  requested_by TEXT,
  created_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE improvement_criterion (
  improvement_id TEXT NOT NULL REFERENCES improvement(id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  proposal_version INTEGER NOT NULL,
  criterion TEXT NOT NULL CHECK(length(criterion) BETWEEN 1 AND 1000),
  actor TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (improvement_id, revision)
) STRICT;
--> statement-breakpoint
CREATE TABLE review_finding_issue_claim (
  key TEXT PRIMARY KEY CHECK(length(key)=64),
  finding_key TEXT NOT NULL,
  item_id TEXT,
  claimed_by TEXT,
  claimed_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE runner_repository_command (
  id TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL REFERENCES runner(id),
  item_id TEXT NOT NULL REFERENCES work_item(id),
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','delivered','done','expired')),
  result TEXT,
  grant_hash TEXT,
  grant_expires_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  done_at INTEGER,
  CHECK((state = 'done') = (result IS NOT NULL))
) STRICT;
--> statement-breakpoint
CREATE TABLE checkpoint_ref_cleanup (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id) ON DELETE CASCADE,
  ended_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE item_blocker_check (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id) ON DELETE CASCADE,
  checked_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE suggested_finding (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  finding_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  location TEXT NOT NULL,
  severity TEXT NOT NULL,
  explanation TEXT NOT NULL,
  handed_at INTEGER NOT NULL,
  decision TEXT CHECK(decision IN ('fixed','declined')),
  reason TEXT,
  head TEXT,
  decided_at INTEGER,
  PRIMARY KEY(item_id, finding_id),
  CHECK((decision IS NULL) = (decided_at IS NULL))
) STRICT;
--> statement-breakpoint
CREATE TABLE suggestion_turn (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('started','skipped')),
  reason TEXT,
  head TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE agent_wait (
  run_id TEXT PRIMARY KEY REFERENCES run(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  waiting_ms INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE improvement_issue_sync (
  improvement_id TEXT PRIMARY KEY REFERENCES improvement(id),
  issue_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('available','missing','unauthorized','unavailable')),
  state_type TEXT,
  team_id TEXT,
  delegated INTEGER CHECK(delegated IS NULL OR delegated IN (0,1)),
  observed_at INTEGER NOT NULL,
  confirmed_at INTEGER
) STRICT;
--> statement-breakpoint
CREATE TABLE improvement_delegation (
  improvement_id TEXT PRIMARY KEY REFERENCES improvement(id),
  issue_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('requested','started','existing','failed')),
  session_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL CHECK(attempts >= 0),
  lease_expires_at INTEGER,
  actor TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(state <> 'requested' OR lease_expires_at IS NOT NULL)
) STRICT;
--> statement-breakpoint
CREATE TABLE improvement_sweep (
  improvement_id TEXT PRIMARY KEY REFERENCES improvement(id),
  checked_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE improvement_work (
  improvement_id TEXT PRIMARY KEY REFERENCES improvement(id),
  issue_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  bound_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE improvement_action (
  id INTEGER PRIMARY KEY,
  improvement_id TEXT NOT NULL REFERENCES improvement(id),
  action TEXT NOT NULL CHECK(action IN
    ('delegate','verify','contradict','criterion','acknowledge','redelegate','return_to_review',
     'follow_work')),
  version INTEGER NOT NULL,
  prior TEXT NOT NULL CHECK(json_valid(prior)),
  detail TEXT NOT NULL CHECK(json_valid(detail)),
  actor TEXT NOT NULL,
  at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE pull_request_text (
  item_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  evidence TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE "runner_agent_policy" (
 runner_id TEXT NOT NULL REFERENCES runner(id),
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex','grok','opencode')),
 ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0,1)),
 auth_expired INTEGER NOT NULL DEFAULT 0 CHECK(auth_expired IN (0,1)),
 quota_state TEXT NOT NULL DEFAULT 'ok' CHECK(quota_state IN ('ok','low','exhausted','spent_extra')),
 resets_at INTEGER,
 cooldown_until INTEGER NOT NULL DEFAULT 0,
 resolved_model TEXT,
 last_used_at INTEGER NOT NULL DEFAULT 0,
 virtual_finish REAL NOT NULL DEFAULT 0,
 extra_usage INTEGER NOT NULL DEFAULT 0 CHECK(extra_usage IN (0,1)),
 PRIMARY KEY(runner_id,agent)
) STRICT;
--> statement-breakpoint
CREATE TABLE "runner_execution_usage" (
 command_id TEXT PRIMARY KEY,
 runner_id TEXT NOT NULL REFERENCES runner(id),
 owner_user_id TEXT NOT NULL REFERENCES workspace_user(id),
 item_id TEXT REFERENCES work_item(id),
 run_id TEXT REFERENCES run(id),
 agent TEXT CHECK(agent IN ('claude','codex','grok','opencode')),
 model TEXT,
 role TEXT NOT NULL CHECK(role IN ('implementer','reviewer')),
 purpose TEXT NOT NULL CHECK(purpose IN ('prepare','work','check','helper')),
 started_at INTEGER NOT NULL,
 ended_at INTEGER,
 outcome TEXT,
 resolved_model TEXT,
 output_bytes INTEGER NOT NULL DEFAULT 0 CHECK(output_bytes>=0),
 resets_at INTEGER CHECK (resets_at IS NULL OR resets_at >= 0),
 placement_reason TEXT CHECK (placement_reason IS NULL OR placement_reason IN ('session_restore','extra_usage')),
 account_policy_revision TEXT
 CHECK(account_policy_revision IS NULL OR length(account_policy_revision) BETWEEN 1 AND 64),
 account_fallback TEXT
 CHECK(account_fallback IS NULL OR length(account_fallback) BETWEEN 1 AND 500)
) STRICT;
--> statement-breakpoint
CREATE TABLE closeout_policy_outage (
  repository TEXT PRIMARY KEY,
  started_at INTEGER NOT NULL,
  error TEXT NOT NULL,
  policy_path TEXT NOT NULL,
  main_sha TEXT NOT NULL,
  changed_by_sha TEXT,
  question_id TEXT,
  question_item_id TEXT
) STRICT;
--> statement-breakpoint
CREATE TABLE closeout_policy_block (
  question_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  repository TEXT NOT NULL,
  cause TEXT NOT NULL CHECK (cause = 'policy_unreadable'),
  error TEXT NOT NULL,
  policy_path TEXT NOT NULL,
  main_sha TEXT NOT NULL,
  changed_by_sha TEXT,
  created_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX job_due ON job (status, run_at, priority);
--> statement-breakpoint
CREATE INDEX outbox_due ON outbox (status, target, not_before, priority);
--> statement-breakpoint
CREATE UNIQUE INDEX inbox_event_delivery ON inbox_event (delivery_id) WHERE delivery_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX inbox_event_unhandled ON inbox_event (handled, received_at);
--> statement-breakpoint
CREATE INDEX run_item ON run (item_id, created_at);
--> statement-breakpoint
CREATE INDEX closeout_progress_item ON closeout_progress (item_id, updated_at);
--> statement-breakpoint
CREATE INDEX closeout_recovery_item ON closeout_recovery (item_id);
--> statement-breakpoint
CREATE INDEX outbox_session_delivery ON outbox (target, ordering_key, delivery_generation, status);
--> statement-breakpoint
CREATE INDEX linear_activity_session ON linear_activity_snapshot (session_id, created_at, id);
--> statement-breakpoint
CREATE INDEX linear_turn_pending ON linear_turn(session_id,state,created_at_ms,ordinal);
--> statement-breakpoint
CREATE INDEX runner_certificate_identity ON runner_certificate(runner_id);
--> statement-breakpoint
CREATE INDEX runner_helper_pending ON runner_helper(runner_id,acknowledged_at,expires_at);
--> statement-breakpoint
CREATE INDEX scheduler_project ON scheduler_admission(project_key);
--> statement-breakpoint
CREATE INDEX outbox_activity_run ON outbox(activity_run_id,sent_at);
--> statement-breakpoint
CREATE INDEX github_integration_hold_pending ON github_integration_hold(status,item_id);
--> statement-breakpoint
CREATE UNIQUE INDEX verified_github_attribution_account ON verified_github_attribution(workspace_id,github_id) WHERE consented_at IS NOT NULL AND revoked_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX decision_suggestion_answer ON decision_suggestion(question_id) WHERE accepted_at IS NOT NULL;
--> statement-breakpoint
CREATE INDEX task_block_blocker ON task_block(blocker_linear_issue_id);
--> statement-breakpoint
CREATE INDEX evidence_item ON evidence (item_id, created_at);
--> statement-breakpoint
CREATE INDEX agent_closeout_event_item ON agent_closeout_event (item_id, run_id);
--> statement-breakpoint
CREATE INDEX merge_queue_entry_repository ON merge_queue_entry(repository, ready_at, id);
--> statement-breakpoint
CREATE INDEX visual_review_item ON visual_review (item_id, check_id);
--> statement-breakpoint
CREATE INDEX visual_review_mark_question ON visual_review_mark (question_id);
--> statement-breakpoint
CREATE INDEX github_delivery_received ON github_delivery (received_at);
--> statement-breakpoint
CREATE INDEX question_session_open ON question (session_id, status);
--> statement-breakpoint
CREATE INDEX question_run_kind ON question (run_id, kind);
--> statement-breakpoint
CREATE UNIQUE INDEX question_one_active_session ON question (session_id)
WHERE status = 'open' AND cancelled_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX question_answer_event ON question (session_id, answer_event_key)
WHERE answer_event_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX inbox_event_issue ON inbox_event(json_extract(payload,'$.data.id'), updated_at_ms)
  WHERE json_extract(payload,'$.type')='Issue';
--> statement-breakpoint
CREATE UNIQUE INDEX parent_delegation_active ON parent_delegation(workspace_id, parent_issue_id) WHERE stopped_at IS NULL;
--> statement-breakpoint
CREATE INDEX parent_delegation_session ON parent_delegation(session_id);
--> statement-breakpoint
CREATE UNIQUE INDEX parent_delegation_issue_active ON parent_delegation_issue(workspace_id, issue_id) WHERE released_at IS NULL;
--> statement-breakpoint
CREATE INDEX parent_delegation_issue_delegation ON parent_delegation_issue(delegation_id);
--> statement-breakpoint
CREATE INDEX runner_enrollment_expiry ON runner_enrollment(expires_at) WHERE used_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX workspace_assignment_link_id ON workspace_assignment(link_id);
--> statement-breakpoint
CREATE INDEX member_vm_enrollment_vm ON member_vm_enrollment(member_vm_id);
--> statement-breakpoint
CREATE UNIQUE INDEX work_item_active_issue ON work_item(linear_issue_id) WHERE state NOT IN ('completed','merged','cancelled');
--> statement-breakpoint
CREATE INDEX work_item_delegation_position ON work_item (delegation_id, position);
--> statement-breakpoint
CREATE INDEX pull_review_open ON pull_review(item_id) WHERE handled_at IS NULL;
--> statement-breakpoint
CREATE INDEX plan_proposal_item ON plan_proposal (item_id);
--> statement-breakpoint
CREATE INDEX pull_comment_open ON pull_comment(item_id) WHERE handled_at IS NULL;
--> statement-breakpoint
CREATE INDEX review_escape_item_open ON review_escape (item_id, settled_at);
--> statement-breakpoint
CREATE INDEX runner_command_pending ON runner_command(runner_id,acknowledged_at,ordinal);
--> statement-breakpoint
CREATE INDEX link_ask_item_open ON link_ask (item_id, closed_at);
--> statement-breakpoint
CREATE INDEX inbox_event_session ON inbox_event(session_id, received_at);
--> statement-breakpoint
CREATE INDEX candidate_paths_item ON candidate_paths (item_id, recorded_at);
--> statement-breakpoint
CREATE INDEX item_continuation_previous ON item_continuation(previous_item_id);
--> statement-breakpoint
CREATE INDEX review_finding_last_seen ON review_finding(status, last_seen_at DESC);
--> statement-breakpoint
CREATE INDEX review_finding_path ON review_finding(repository, review, path);
--> statement-breakpoint
CREATE INDEX review_finding_item_item ON review_finding_item(item_id);
--> statement-breakpoint
CREATE INDEX finding_group_workspace ON finding_group(workspace_id,status);
--> statement-breakpoint
CREATE INDEX agent_model_probe_refresh ON agent_model_probe(runner_id,user_id,agent,model,requested_at);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_model_probe_pending ON agent_model_probe(runner_id) WHERE finished_at IS NULL;
--> statement-breakpoint
CREATE INDEX runner_login_account ON runner_login(runner_id,user_id,agent,updated_at);
--> statement-breakpoint
CREATE INDEX review_reply_item_open ON review_reply (item_id, replied_at);
--> statement-breakpoint
CREATE INDEX rebase_return_item ON rebase_return (item_id,activation_id);
--> statement-breakpoint
CREATE UNIQUE INDEX agent_account_legacy ON agent_account(workspace_id,agent)
 WHERE legacy=1;
--> statement-breakpoint
CREATE UNIQUE INDEX agent_account_label
 ON agent_account(workspace_id,agent,lower(label)) WHERE removed_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX agent_binding_legacy ON agent_account_binding(runner_id,agent)
 WHERE legacy=1;
--> statement-breakpoint
CREATE UNIQUE INDEX agent_binding_runner_account
 ON agent_account_binding(runner_id,account_id) WHERE removed_at IS NULL;
--> statement-breakpoint
CREATE INDEX agent_binding_account ON agent_account_binding(account_id);
--> statement-breakpoint
CREATE INDEX runner_command_account_binding ON runner_command_account(binding_id);
--> statement-breakpoint
CREATE INDEX pull_ci_failure_pending ON pull_ci_failure(item_id) WHERE handled_at IS NULL;
--> statement-breakpoint
CREATE INDEX runner_event_type ON runner_event(run_id,generation,type);
--> statement-breakpoint
CREATE INDEX runner_login_binding ON runner_login(binding_id) WHERE binding_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX agent_account_health_agent
 ON agent_account_health(workspace_id,agent,next_check_at);
--> statement-breakpoint
CREATE UNIQUE INDEX run_fallback_attempt_open
  ON run_fallback_attempt(run_id,call_id,runner_id,generation,excluded_key,outcome)
  WHERE closed_at IS NULL;
--> statement-breakpoint
CREATE INDEX linear_comment_issue ON linear_comment(issue_id, state);
--> statement-breakpoint
CREATE INDEX linear_comment_item ON linear_comment(item_id, state);
--> statement-breakpoint
CREATE INDEX retro_workspace ON retro(workspace_id, window_end);
--> statement-breakpoint
CREATE INDEX retro_coverage_gap_retro ON retro_coverage_gap(retro_id);
--> statement-breakpoint
CREATE INDEX improvement_workspace ON improvement(workspace_id, review_state);
--> statement-breakpoint
CREATE INDEX improvement_issue ON improvement(workspace_id, issue_id) WHERE issue_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX improvement_delivery_open ON improvement_delivery(state)
  WHERE state IN ('pending','claimed','failed','unknown');
--> statement-breakpoint
CREATE INDEX improvement_outcome_improvement ON improvement_outcome(improvement_id, id);
--> statement-breakpoint
CREATE INDEX retro_dispatch_runner_open ON retro_dispatch(runner_id) WHERE released_at IS NULL;
--> statement-breakpoint
CREATE INDEX retro_dispatch_unsettled ON retro_dispatch(retro_id) WHERE settled_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX retro_occurrence_scheduled ON retro_occurrence(workspace_id, occurrence_at)
  WHERE origin = 'scheduled';
--> statement-breakpoint
CREATE INDEX review_finding_issue_claim_finding ON review_finding_issue_claim(finding_key);
--> statement-breakpoint
CREATE INDEX runner_repository_command_runner ON runner_repository_command(runner_id, state);
--> statement-breakpoint
CREATE INDEX merge_queue_entry_lane ON merge_queue_entry(repository, lane, ready_at, id);
--> statement-breakpoint
CREATE INDEX improvement_action_improvement ON improvement_action(improvement_id, id);
--> statement-breakpoint
CREATE INDEX runner_usage_item ON runner_execution_usage(item_id,ended_at);
--> statement-breakpoint
CREATE INDEX runner_usage_runner_ended ON runner_execution_usage(runner_id, ended_at);
--> statement-breakpoint
CREATE INDEX closeout_policy_block_repository ON closeout_policy_block(repository);
--> statement-breakpoint
CREATE TRIGGER revoke_member_runners AFTER UPDATE OF active ON workspace_member
WHEN NEW.active=0
BEGIN
  UPDATE runner SET status='revoked',revoked_at=NEW.checked_at,fence=fence+1
  WHERE workspace_id=NEW.workspace_id AND owner_user_id=NEW.user_id AND revoked_at IS NULL;
  UPDATE runner_certificate SET revoked_at=NEW.checked_at WHERE revoked_at IS NULL
  AND runner_id IN (SELECT id FROM runner WHERE workspace_id=NEW.workspace_id AND owner_user_id=NEW.user_id);
END;
--> statement-breakpoint
CREATE TRIGGER runner_setup_check_enrolled AFTER INSERT ON runner
WHEN EXISTS(SELECT 1 FROM runner_setup_hold)
BEGIN
INSERT INTO job(queue,payload,run_at,max_attempts,created_at)
  SELECT 'runner_setup.check',json_object('ownerUserId',owners.id),0,3,
    CAST(strftime('%s','now') AS INTEGER)*1000
  FROM (SELECT DISTINCT h.owner_user_id AS id FROM runner_setup_hold h
    WHERE h.owner_user_id IS NOT NULL AND (h.owner_user_id=(SELECT r.owner_user_id FROM runner r WHERE r.id=NEW.id) OR EXISTS(SELECT 1 FROM runner_policy p WHERE p.runner_id=NEW.id AND p.sharing=1))) owners
  WHERE NOT EXISTS(SELECT 1 FROM job j WHERE j.queue='runner_setup.check' AND j.status='pending'
    AND json_extract(j.payload,'$.ownerUserId')=owners.id);
END;
--> statement-breakpoint
CREATE TRIGGER runner_setup_check_online AFTER UPDATE OF last_seen_at ON runner
WHEN (OLD.last_seen_at IS NULL OR NEW.last_seen_at-OLD.last_seen_at>=60000)
  AND EXISTS(SELECT 1 FROM runner_setup_hold)
BEGIN
INSERT INTO job(queue,payload,run_at,max_attempts,created_at)
  SELECT 'runner_setup.check',json_object('ownerUserId',owners.id),0,3,
    CAST(strftime('%s','now') AS INTEGER)*1000
  FROM (SELECT DISTINCT h.owner_user_id AS id FROM runner_setup_hold h
    WHERE h.owner_user_id IS NOT NULL AND (h.owner_user_id=(SELECT r.owner_user_id FROM runner r WHERE r.id=NEW.id) OR EXISTS(SELECT 1 FROM runner_policy p WHERE p.runner_id=NEW.id AND p.sharing=1))) owners
  WHERE NOT EXISTS(SELECT 1 FROM job j WHERE j.queue='runner_setup.check' AND j.status='pending'
    AND json_extract(j.payload,'$.ownerUserId')=owners.id);
END;
--> statement-breakpoint
CREATE TRIGGER runner_setup_check_shared AFTER INSERT ON runner_policy
WHEN NEW.sharing=1 AND EXISTS(SELECT 1 FROM runner_setup_hold)
BEGIN
INSERT INTO job(queue,payload,run_at,max_attempts,created_at)
  SELECT 'runner_setup.check',json_object('ownerUserId',owners.id),0,3,
    CAST(strftime('%s','now') AS INTEGER)*1000
  FROM (SELECT DISTINCT h.owner_user_id AS id FROM runner_setup_hold h
    WHERE h.owner_user_id IS NOT NULL AND (h.owner_user_id=(SELECT r.owner_user_id FROM runner r WHERE r.id=NEW.runner_id) OR EXISTS(SELECT 1 FROM runner_policy p WHERE p.runner_id=NEW.runner_id AND p.sharing=1))) owners
  WHERE NOT EXISTS(SELECT 1 FROM job j WHERE j.queue='runner_setup.check' AND j.status='pending'
    AND json_extract(j.payload,'$.ownerUserId')=owners.id);
END;
--> statement-breakpoint
CREATE TRIGGER runner_setup_check_sharing AFTER UPDATE OF sharing ON runner_policy
WHEN NEW.sharing=1 AND OLD.sharing<>1 AND EXISTS(SELECT 1 FROM runner_setup_hold)
BEGIN
INSERT INTO job(queue,payload,run_at,max_attempts,created_at)
  SELECT 'runner_setup.check',json_object('ownerUserId',owners.id),0,3,
    CAST(strftime('%s','now') AS INTEGER)*1000
  FROM (SELECT DISTINCT h.owner_user_id AS id FROM runner_setup_hold h
    WHERE h.owner_user_id IS NOT NULL AND (h.owner_user_id=(SELECT r.owner_user_id FROM runner r WHERE r.id=NEW.runner_id) OR EXISTS(SELECT 1 FROM runner_policy p WHERE p.runner_id=NEW.runner_id AND p.sharing=1))) owners
  WHERE NOT EXISTS(SELECT 1 FROM job j WHERE j.queue='runner_setup.check' AND j.status='pending'
    AND json_extract(j.payload,'$.ownerUserId')=owners.id);
END;
--> statement-breakpoint
CREATE TRIGGER runner_setup_check_vm_ready AFTER UPDATE OF step ON member_vm
WHEN NEW.step='ready' AND OLD.step<>'ready' AND EXISTS(SELECT 1 FROM runner_setup_hold)
BEGIN
INSERT INTO job(queue,payload,run_at,max_attempts,created_at)
  SELECT 'runner_setup.check',json_object('ownerUserId',owners.id),0,3,
    CAST(strftime('%s','now') AS INTEGER)*1000
  FROM (SELECT DISTINCT h.owner_user_id AS id FROM runner_setup_hold h
    WHERE h.owner_user_id IS NOT NULL AND (h.owner_user_id=(SELECT r.owner_user_id FROM runner r WHERE r.id=NEW.runner_id) OR EXISTS(SELECT 1 FROM runner_policy p WHERE p.runner_id=NEW.runner_id AND p.sharing=1) OR h.owner_user_id=NEW.user_id)) owners
  WHERE NOT EXISTS(SELECT 1 FROM job j WHERE j.queue='runner_setup.check' AND j.status='pending'
    AND json_extract(j.payload,'$.ownerUserId')=owners.id);
END;
--> statement-breakpoint
CREATE TRIGGER runner_setup_hold_ends AFTER UPDATE OF state,cancel_requested ON work_item
WHEN NEW.state<>'queued' OR NEW.cancel_requested=1
BEGIN
  DELETE FROM runner_setup_hold WHERE item_id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER runner_setup_resume_ends AFTER UPDATE OF cancel_requested ON work_item
WHEN NEW.cancel_requested=1
BEGIN
  DELETE FROM runner_setup_resume WHERE item_id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER revoke_workspace_member_access AFTER UPDATE OF revoked_at ON workspace_member
WHEN NEW.revoked_at IS NOT NULL
BEGIN
  DELETE FROM workspace_session WHERE workspace_id=NEW.workspace_id AND user_id=NEW.user_id;
  UPDATE runner SET status='revoked',revoked_at=NEW.revoked_at,fence=fence+1
    WHERE workspace_id=NEW.workspace_id AND owner_user_id=NEW.user_id AND revoked_at IS NULL;
  UPDATE runner_certificate SET revoked_at=NEW.revoked_at WHERE revoked_at IS NULL
    AND runner_id IN (SELECT id FROM runner WHERE workspace_id=NEW.workspace_id AND owner_user_id=NEW.user_id);
END;
--> statement-breakpoint
CREATE TRIGGER job_initial_activation AFTER INSERT ON job BEGIN
  INSERT INTO job_activation (job_id) VALUES (NEW.id);
  UPDATE job SET activation_id=last_insert_rowid() WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER restart_hold_release AFTER UPDATE OF state ON work_item
WHEN NEW.state NOT IN ('recovering', 'awaiting_input')
BEGIN
  DELETE FROM restart_hold WHERE item_id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER agent_account_identity BEFORE UPDATE OF id,workspace_id,agent,legacy
ON agent_account
BEGIN
SELECT RAISE(ABORT,'agent account identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER agent_account_kept BEFORE DELETE ON agent_account
BEGIN
SELECT RAISE(ABORT,'agent accounts are removed, not deleted');
END;
--> statement-breakpoint
CREATE TRIGGER agent_binding_runner_workspace BEFORE INSERT ON agent_account_binding
WHEN NOT EXISTS(SELECT 1 FROM runner WHERE id=NEW.runner_id AND workspace_id=NEW.workspace_id)
BEGIN
SELECT RAISE(ABORT,'agent binding runner belongs to another workspace');
END;
--> statement-breakpoint
CREATE TRIGGER agent_binding_identity
BEFORE UPDATE OF id,workspace_id,account_id,agent,runner_id,legacy ON agent_account_binding
BEGIN
SELECT RAISE(ABORT,'agent binding identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER agent_binding_kept BEFORE DELETE ON agent_account_binding
BEGIN
SELECT RAISE(ABORT,'agent bindings are removed, not deleted');
END;
--> statement-breakpoint
CREATE TRIGGER runner_command_account_binding BEFORE INSERT ON runner_command_account
WHEN NOT EXISTS(SELECT 1 FROM agent_account_binding b WHERE b.id=NEW.binding_id
  AND b.account_id=NEW.account_id AND b.workspace_id=NEW.workspace_id AND b.agent=NEW.agent
  AND b.runner_id=NEW.runner_id AND b.legacy<>NEW.named)
BEGIN
SELECT RAISE(ABORT,'runner command account does not match its binding');
END;
--> statement-breakpoint
CREATE TRIGGER runner_command_account_kept
BEFORE UPDATE ON runner_command_account
BEGIN
SELECT RAISE(ABORT,'runner command account is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER runner_command_account_retained
BEFORE DELETE ON runner_command_account
BEGIN
SELECT RAISE(ABORT,'runner command account is retained');
END;
--> statement-breakpoint
CREATE TRIGGER retro_settings_revision_immutable BEFORE UPDATE ON retro_settings_revision
BEGIN SELECT RAISE(ABORT, 'retro settings revisions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER retro_frozen BEFORE UPDATE ON retro
WHEN OLD.workspace_id IS NOT NEW.workspace_id OR OLD.window_start IS NOT NEW.window_start
  OR OLD.window_end IS NOT NEW.window_end OR OLD.origin IS NOT NEW.origin
  OR OLD.settings_revision IS NOT NEW.settings_revision OR OLD.prompt IS NOT NEW.prompt
  OR OLD.agent_profile IS NOT NEW.agent_profile OR OLD.repositories IS NOT NEW.repositories
  OR OLD.output_limits IS NOT NEW.output_limits OR OLD.execution_limits IS NOT NEW.execution_limits
  OR (OLD.digest_sha256 IS NOT NULL AND OLD.digest_sha256 IS NOT NEW.digest_sha256)
  OR (OLD.manifest_sha256 IS NOT NULL AND OLD.manifest_sha256 IS NOT NEW.manifest_sha256)
  OR (OLD.state = 'published' AND (NEW.state <> 'published' OR OLD.result IS NOT NEW.result
    OR OLD.result_sha256 IS NOT NEW.result_sha256))
BEGIN SELECT RAISE(ABORT, 'retro frozen input and published result are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER retro_repository_frozen BEFORE UPDATE ON retro_repository
WHEN OLD.start_cursor IS NOT NEW.start_cursor OR OLD.repository IS NOT NEW.repository
  OR (OLD.end_cursor IS NOT NULL AND OLD.end_cursor IS NOT NEW.end_cursor)
BEGIN SELECT RAISE(ABORT, 'retro collection cursors are frozen'); END;
--> statement-breakpoint
CREATE TRIGGER retro_evidence_immutable BEFORE UPDATE ON retro_evidence
BEGIN SELECT RAISE(ABORT, 'retro evidence is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER retro_artifact_immutable BEFORE UPDATE ON retro_artifact
BEGIN SELECT RAISE(ABORT, 'retro artifacts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER improvement_source_immutable BEFORE UPDATE ON improvement_source
BEGIN SELECT RAISE(ABORT, 'improvement source references are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER improvement_proposal_immutable BEFORE UPDATE ON improvement_proposal
BEGIN SELECT RAISE(ABORT, 'improvement proposals are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER improvement_decision_immutable BEFORE UPDATE ON improvement_decision
BEGIN SELECT RAISE(ABORT, 'improvement decisions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER retro_item_immutable BEFORE UPDATE ON retro_item
BEGIN SELECT RAISE(ABORT, 'retro items are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER improvement_delivery_attempt_settled BEFORE UPDATE ON improvement_delivery_attempt
WHEN OLD.outcome <> 'claimed' OR OLD.owner IS NOT NEW.owner OR OLD.claimed_at IS NOT NEW.claimed_at
  OR OLD.claim_expires_at IS NOT NEW.claim_expires_at
BEGIN SELECT RAISE(ABORT, 'settled delivery attempts are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER improvement_outcome_immutable BEFORE UPDATE ON improvement_outcome
BEGIN SELECT RAISE(ABORT, 'improvement outcome history is immutable'); END;
--> statement-breakpoint
CREATE TRIGGER retro_dispatch_frozen BEFORE UPDATE ON retro_dispatch
WHEN OLD.retro_id IS NOT NEW.retro_id OR OLD.attempt IS NOT NEW.attempt
  OR OLD.runner_id IS NOT NEW.runner_id OR OLD.runner_fence IS NOT NEW.runner_fence
  OR OLD.command IS NOT NEW.command
  OR (OLD.result IS NOT NULL AND OLD.result IS NOT NEW.result)
  OR (OLD.released_at IS NOT NULL AND (OLD.released_at IS NOT NEW.released_at
    OR OLD.release_reason IS NOT NEW.release_reason))
BEGIN SELECT RAISE(ABORT, 'retro dispatch identity, result and release are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER retro_occurrence_immutable BEFORE UPDATE ON retro_occurrence
BEGIN SELECT RAISE(ABORT, 'retro occurrences are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER improvement_criterion_immutable BEFORE UPDATE ON improvement_criterion
BEGIN SELECT RAISE(ABORT, 'improvement criterion annotations are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER checkpoint_ref_cleanup_ended AFTER UPDATE OF state ON work_item
WHEN NEW.state IN ('completed','merged','cancelled')
  AND OLD.state NOT IN ('completed','merged','cancelled')
  AND NEW.branch_name IS NOT NULL AND NEW.branch_name != ''
BEGIN
  INSERT OR REPLACE INTO checkpoint_ref_cleanup(item_id,ended_at)
  VALUES(NEW.id, CAST(strftime('%s','now') AS INTEGER)*1000);
END;
--> statement-breakpoint
CREATE TRIGGER improvement_delivery_remote_reserved BEFORE UPDATE ON improvement_delivery
WHEN OLD.remote_id IS NOT NULL AND OLD.remote_id IS NOT NEW.remote_id
BEGIN SELECT RAISE(ABORT, 'improvement delivery remote id is reserved'); END;
--> statement-breakpoint
CREATE TRIGGER improvement_delivery_intent_frozen BEFORE UPDATE ON improvement_delivery
WHEN OLD.operation IS NOT NEW.operation OR OLD.target_issue_id IS NOT NEW.target_issue_id
  OR OLD.content IS NOT NEW.content
  OR (OLD.target_team_id IS NOT NEW.target_team_id AND NOT (
    OLD.operation = 'create_issue' AND OLD.state = 'failed' AND OLD.blocked = 'destination'
    AND OLD.remote_id IS NULL AND NEW.target_team_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'improvement delivery intent is frozen'); END;
--> statement-breakpoint
CREATE TRIGGER improvement_action_immutable BEFORE UPDATE ON improvement_action
BEGIN SELECT RAISE(ABORT, 'improvement follow-through actions are immutable'); END;
--> statement-breakpoint
CREATE TRIGGER runner_setup_check_agent_added AFTER INSERT ON runner_agent_policy
WHEN NEW.ready=1 AND NEW.auth_expired=0 AND EXISTS(SELECT 1 FROM runner_setup_hold)
BEGIN
INSERT INTO job(queue,payload,run_at,max_attempts,created_at)
  SELECT 'runner_setup.check',json_object('ownerUserId',owners.id),0,3,
    CAST(strftime('%s','now') AS INTEGER)*1000
  FROM (SELECT DISTINCT h.owner_user_id AS id FROM runner_setup_hold h
    WHERE h.owner_user_id IS NOT NULL AND (h.owner_user_id=(SELECT r.owner_user_id FROM runner r WHERE r.id=NEW.runner_id) OR EXISTS(SELECT 1 FROM runner_policy p WHERE p.runner_id=NEW.runner_id AND p.sharing=1))) owners
  WHERE NOT EXISTS(SELECT 1 FROM job j WHERE j.queue='runner_setup.check' AND j.status='pending'
    AND json_extract(j.payload,'$.ownerUserId')=owners.id);
END;
--> statement-breakpoint
CREATE TRIGGER runner_setup_check_agent_ready AFTER UPDATE OF ready,auth_expired ON runner_agent_policy
WHEN NEW.ready=1 AND NEW.auth_expired=0 AND (OLD.ready<>1 OR OLD.auth_expired<>0)
  AND EXISTS(SELECT 1 FROM runner_setup_hold)
BEGIN
INSERT INTO job(queue,payload,run_at,max_attempts,created_at)
  SELECT 'runner_setup.check',json_object('ownerUserId',owners.id),0,3,
    CAST(strftime('%s','now') AS INTEGER)*1000
  FROM (SELECT DISTINCT h.owner_user_id AS id FROM runner_setup_hold h
    WHERE h.owner_user_id IS NOT NULL AND (h.owner_user_id=(SELECT r.owner_user_id FROM runner r WHERE r.id=NEW.runner_id) OR EXISTS(SELECT 1 FROM runner_policy p WHERE p.runner_id=NEW.runner_id AND p.sharing=1))) owners
  WHERE NOT EXISTS(SELECT 1 FROM job j WHERE j.queue='runner_setup.check' AND j.status='pending'
    AND json_extract(j.payload,'$.ownerUserId')=owners.id);
END;
--> statement-breakpoint
CREATE TRIGGER agent_binding_legacy_added AFTER INSERT ON runner_agent_policy
BEGIN
INSERT OR IGNORE INTO agent_account(id,workspace_id,agent,label,legacy,enabled,created_at,updated_at)
  SELECT 'legacy_'||NEW.agent||'_'||r.workspace_id,r.workspace_id,NEW.agent,
    CASE NEW.agent WHEN 'claude' THEN 'Claude' WHEN 'codex' THEN 'Codex' WHEN 'grok' THEN 'Grok'
      ELSE 'OpenCode' END||' default sign-in',
    1,1,CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000
  FROM runner r WHERE r.id=NEW.runner_id;
INSERT OR IGNORE INTO agent_account_binding(id,workspace_id,account_id,agent,runner_id,legacy,quota_scope,created_at)
  SELECT 'legacy_'||NEW.agent||'_'||r.id,r.workspace_id,'legacy_'||NEW.agent||'_'||r.workspace_id,
    NEW.agent,r.id,1,'unknown',CAST(strftime('%s','now') AS INTEGER)*1000
  FROM runner r WHERE r.id=NEW.runner_id;
END;
