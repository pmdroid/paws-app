import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261103T2026_retro_improvements",
  sql: `
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
CREATE TRIGGER retro_settings_revision_immutable BEFORE UPDATE ON retro_settings_revision
BEGIN SELECT RAISE(ABORT, 'retro settings revisions are immutable'); END;

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
CREATE INDEX retro_workspace ON retro(workspace_id, window_end);
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

CREATE TABLE retro_repository (
  retro_id TEXT NOT NULL REFERENCES retro(id),
  repository TEXT NOT NULL COLLATE NOCASE,
  start_cursor INTEGER NOT NULL,
  end_cursor INTEGER CHECK(end_cursor IS NULL OR end_cursor >= start_cursor),
  PRIMARY KEY (retro_id, repository)
) STRICT;
CREATE TRIGGER retro_repository_frozen BEFORE UPDATE ON retro_repository
WHEN OLD.start_cursor IS NOT NEW.start_cursor OR OLD.repository IS NOT NEW.repository
  OR (OLD.end_cursor IS NOT NULL AND OLD.end_cursor IS NOT NEW.end_cursor)
BEGIN SELECT RAISE(ABORT, 'retro collection cursors are frozen'); END;

CREATE TABLE retro_watermark (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  repository TEXT NOT NULL COLLATE NOCASE,
  cursor INTEGER NOT NULL,
  retro_id TEXT NOT NULL REFERENCES retro(id),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, repository)
) STRICT;

CREATE TABLE retro_collection_lock (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  repository TEXT NOT NULL COLLATE NOCASE,
  retro_id TEXT NOT NULL REFERENCES retro(id),
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, repository)
) STRICT;

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
CREATE TRIGGER retro_evidence_immutable BEFORE UPDATE ON retro_evidence
BEGIN SELECT RAISE(ABORT, 'retro evidence is immutable'); END;

CREATE TABLE retro_coverage_gap (
  id INTEGER PRIMARY KEY,
  retro_id TEXT NOT NULL REFERENCES retro(id),
  repository TEXT COLLATE NOCASE,
  kind TEXT NOT NULL CHECK(kind IN
    ('missing_artifact','hash_mismatch','retention_gap','source_unavailable')),
  detail TEXT NOT NULL CHECK(length(detail) BETWEEN 1 AND 2000),
  recorded_at INTEGER NOT NULL
) STRICT;
CREATE INDEX retro_coverage_gap_retro ON retro_coverage_gap(retro_id);

CREATE TABLE retro_artifact (
  retro_id TEXT NOT NULL REFERENCES retro(id),
  kind TEXT NOT NULL CHECK(kind IN ('digest','manifest','prompt','report')),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
  file_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (retro_id, kind)
) STRICT;
CREATE TRIGGER retro_artifact_immutable BEFORE UPDATE ON retro_artifact
BEGIN SELECT RAISE(ABORT, 'retro artifacts are immutable'); END;

CREATE TABLE retro_schedule_runtime (
  workspace_id TEXT PRIMARY KEY REFERENCES workspace(id),
  last_occurrence_at INTEGER,
  last_retro_id TEXT REFERENCES retro(id),
  next_due_at INTEGER,
  updated_at INTEGER NOT NULL
) STRICT;

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
CREATE INDEX improvement_workspace ON improvement(workspace_id, review_state);
CREATE INDEX improvement_issue ON improvement(workspace_id, issue_id) WHERE issue_id IS NOT NULL;

CREATE TABLE improvement_source (
  workspace_id TEXT NOT NULL REFERENCES workspace(id),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('retro_item','daily_finding')),
  source_key TEXT NOT NULL CHECK(length(source_key) BETWEEN 1 AND 400),
  improvement_id TEXT NOT NULL REFERENCES improvement(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, source_kind, source_key)
) STRICT;
CREATE TRIGGER improvement_source_immutable BEFORE UPDATE ON improvement_source
BEGIN SELECT RAISE(ABORT, 'improvement source references are immutable'); END;

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
CREATE TRIGGER improvement_proposal_immutable BEFORE UPDATE ON improvement_proposal
BEGIN SELECT RAISE(ABORT, 'improvement proposals are immutable'); END;

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
CREATE TRIGGER improvement_decision_immutable BEFORE UPDATE ON improvement_decision
BEGIN SELECT RAISE(ABORT, 'improvement decisions are immutable'); END;

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
CREATE TRIGGER retro_item_immutable BEFORE UPDATE ON retro_item
BEGIN SELECT RAISE(ABORT, 'retro items are immutable'); END;

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
  updated_at INTEGER NOT NULL,
  UNIQUE (improvement_id, operation),
  CHECK(operation = 'create_issue' OR target_issue_id IS NOT NULL),
  CHECK(state <> 'claimed' OR (claim_owner IS NOT NULL AND claim_expires_at IS NOT NULL))
) STRICT;
CREATE INDEX improvement_delivery_open ON improvement_delivery(state)
  WHERE state IN ('pending','claimed','failed','unknown');

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
CREATE TRIGGER improvement_delivery_attempt_settled BEFORE UPDATE ON improvement_delivery_attempt
WHEN OLD.outcome <> 'claimed' OR OLD.owner IS NOT NEW.owner OR OLD.claimed_at IS NOT NEW.claimed_at
  OR OLD.claim_expires_at IS NOT NEW.claim_expires_at
BEGIN SELECT RAISE(ABORT, 'settled delivery attempts are immutable'); END;

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
CREATE INDEX improvement_outcome_improvement ON improvement_outcome(improvement_id, id);
CREATE TRIGGER improvement_outcome_immutable BEFORE UPDATE ON improvement_outcome
BEGIN SELECT RAISE(ABORT, 'improvement outcome history is immutable'); END;
`,
};
