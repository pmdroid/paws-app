import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261029T1559_opencode_agent_rows",
  foreignKeys: false,
  sql: `
CREATE TABLE runner_agent_policy_opencode (
 runner_id TEXT NOT NULL REFERENCES runner(id),
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex','grok','opencode')),
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
INSERT INTO runner_agent_policy_opencode SELECT * FROM runner_agent_policy;
DROP TABLE runner_agent_policy;
ALTER TABLE runner_agent_policy_opencode RENAME TO runner_agent_policy;

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

CREATE TABLE runner_execution_usage_opencode (
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
 placement_reason TEXT CHECK (placement_reason IS NULL OR placement_reason IN ('session_restore'))
) STRICT;
INSERT INTO runner_execution_usage_opencode SELECT * FROM runner_execution_usage;
DROP TABLE runner_execution_usage;
ALTER TABLE runner_execution_usage_opencode RENAME TO runner_execution_usage;
CREATE INDEX runner_usage_item ON runner_execution_usage(item_id,ended_at);
CREATE INDEX runner_usage_runner_ended ON runner_execution_usage(runner_id, ended_at);

CREATE TABLE agent_model_catalog_opencode (
 runner_id TEXT NOT NULL REFERENCES runner(id),
 user_id TEXT NOT NULL REFERENCES workspace_user(id),
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex','grok','opencode')),
 model TEXT NOT NULL,
 result_json TEXT NOT NULL CHECK(json_valid(result_json)),
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(runner_id,user_id,agent,model)
) STRICT;
INSERT INTO agent_model_catalog_opencode SELECT * FROM agent_model_catalog;
DROP TABLE agent_model_catalog;
ALTER TABLE agent_model_catalog_opencode RENAME TO agent_model_catalog;

CREATE TABLE agent_model_probe_opencode (
 command_id TEXT PRIMARY KEY REFERENCES runner_command(id),
 runner_id TEXT NOT NULL REFERENCES runner(id),
 user_id TEXT NOT NULL REFERENCES workspace_user(id),
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex','grok','opencode')),
 model TEXT NOT NULL,
 requested_at INTEGER NOT NULL,
 finished_at INTEGER
) STRICT;
INSERT INTO agent_model_probe_opencode SELECT * FROM agent_model_probe;
DROP TABLE agent_model_probe;
ALTER TABLE agent_model_probe_opencode RENAME TO agent_model_probe;
CREATE INDEX agent_model_probe_refresh ON agent_model_probe(runner_id,user_id,agent,model,requested_at);
CREATE UNIQUE INDEX agent_model_probe_pending ON agent_model_probe(runner_id) WHERE finished_at IS NULL;

CREATE TABLE runner_login_opencode (
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
) STRICT;
INSERT INTO runner_login_opencode SELECT * FROM runner_login;
DROP TABLE runner_login;
ALTER TABLE runner_login_opencode RENAME TO runner_login;
CREATE INDEX runner_login_account ON runner_login(runner_id,user_id,agent,updated_at);
`,
};
