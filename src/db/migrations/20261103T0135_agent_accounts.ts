import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261103T0135_agent_accounts",
  sql: `
CREATE TABLE IF NOT EXISTS agent_account (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 128),
 workspace_id TEXT NOT NULL REFERENCES workspace(id),
 agent TEXT NOT NULL CHECK(agent IN ('claude','codex','grok','opencode')),
 label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 80),
 legacy INTEGER NOT NULL DEFAULT 0 CHECK(legacy IN (0,1)),
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 removed_at INTEGER,
 UNIQUE(id,workspace_id,agent)
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS agent_account_legacy ON agent_account(workspace_id,agent)
 WHERE legacy=1;
CREATE UNIQUE INDEX IF NOT EXISTS agent_account_label
 ON agent_account(workspace_id,agent,lower(label)) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_account_binding (
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
CREATE UNIQUE INDEX IF NOT EXISTS agent_binding_legacy ON agent_account_binding(runner_id,agent)
 WHERE legacy=1;
CREATE UNIQUE INDEX IF NOT EXISTS agent_binding_runner_account
 ON agent_account_binding(runner_id,account_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS agent_binding_account ON agent_account_binding(account_id);

CREATE TABLE IF NOT EXISTS runner_command_account (
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
CREATE INDEX IF NOT EXISTS runner_command_account_binding ON runner_command_account(binding_id);

CREATE TABLE IF NOT EXISTS runner_account_capability (
 runner_id TEXT PRIMARY KEY REFERENCES runner(id),
 protocol INTEGER NOT NULL CHECK(protocol>=1),
 bindings TEXT NOT NULL CHECK(json_valid(bindings)),
 reported_at INTEGER NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS agent_account_identity BEFORE UPDATE OF id,workspace_id,agent,legacy
ON agent_account
BEGIN
SELECT RAISE(ABORT,'agent account identity is immutable');
END;
CREATE TRIGGER IF NOT EXISTS agent_account_kept BEFORE DELETE ON agent_account
BEGIN
SELECT RAISE(ABORT,'agent accounts are removed, not deleted');
END;
CREATE TRIGGER IF NOT EXISTS agent_binding_runner_workspace BEFORE INSERT ON agent_account_binding
WHEN NOT EXISTS(SELECT 1 FROM runner WHERE id=NEW.runner_id AND workspace_id=NEW.workspace_id)
BEGIN
SELECT RAISE(ABORT,'agent binding runner belongs to another workspace');
END;
CREATE TRIGGER IF NOT EXISTS agent_binding_identity
BEFORE UPDATE OF id,workspace_id,account_id,agent,runner_id,legacy ON agent_account_binding
BEGIN
SELECT RAISE(ABORT,'agent binding identity is immutable');
END;
CREATE TRIGGER IF NOT EXISTS agent_binding_kept BEFORE DELETE ON agent_account_binding
BEGIN
SELECT RAISE(ABORT,'agent bindings are removed, not deleted');
END;
CREATE TRIGGER IF NOT EXISTS runner_command_account_binding BEFORE INSERT ON runner_command_account
WHEN NOT EXISTS(SELECT 1 FROM agent_account_binding b WHERE b.id=NEW.binding_id
  AND b.account_id=NEW.account_id AND b.workspace_id=NEW.workspace_id AND b.agent=NEW.agent
  AND b.runner_id=NEW.runner_id AND b.legacy<>NEW.named)
BEGIN
SELECT RAISE(ABORT,'runner command account does not match its binding');
END;
CREATE TRIGGER IF NOT EXISTS runner_command_account_kept
BEFORE UPDATE ON runner_command_account
BEGIN
SELECT RAISE(ABORT,'runner command account is immutable');
END;
CREATE TRIGGER IF NOT EXISTS runner_command_account_retained
BEFORE DELETE ON runner_command_account
BEGIN
SELECT RAISE(ABORT,'runner command account is retained');
END;

CREATE TRIGGER IF NOT EXISTS agent_binding_legacy_added AFTER INSERT ON runner_agent_policy
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

INSERT OR IGNORE INTO agent_account(id,workspace_id,agent,label,legacy,enabled,created_at,updated_at)
SELECT DISTINCT 'legacy_'||p.agent||'_'||r.workspace_id,r.workspace_id,p.agent,
  CASE p.agent WHEN 'claude' THEN 'Claude' WHEN 'codex' THEN 'Codex' WHEN 'grok' THEN 'Grok'
    ELSE 'OpenCode' END||' default sign-in',
  1,1,CAST(strftime('%s','now') AS INTEGER)*1000,CAST(strftime('%s','now') AS INTEGER)*1000
FROM runner_agent_policy p JOIN runner r ON r.id=p.runner_id;
INSERT OR IGNORE INTO agent_account_binding(id,workspace_id,account_id,agent,runner_id,legacy,quota_scope,created_at)
SELECT 'legacy_'||p.agent||'_'||r.id,r.workspace_id,'legacy_'||p.agent||'_'||r.workspace_id,
  p.agent,r.id,1,'unknown',CAST(strftime('%s','now') AS INTEGER)*1000
FROM runner_agent_policy p JOIN runner r ON r.id=p.runner_id;
`,
};
