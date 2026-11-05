import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Database } from "bun:sqlite";
import type { Migration } from "../migration";

function retiredConfigExtraUsageAgents(db: Database): string[] {
  if (!db.filename || db.filename === ":memory:") return [];
  const path = join(dirname(db.filename), "config.toml");
  if (!existsSync(path)) return [];
  let section = "";
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) section = header[1]!.trim();
    const value = /^extra_usage\s*=\s*\[(.*)\]$/.exec(line);
    if (section === "agents" && value)
      return [...value[1]!.matchAll(/"([^"]*)"|'([^']*)'/g)].map((match) => match[1] ?? match[2]!);
  }
  return [];
}

export const migration: Migration = {
  id: "20261105T2237_runner_extra_usage",
  foreignKeys: false,
  guard(db) {
    db.run("CREATE TEMP TABLE extra_usage_import(agent TEXT NOT NULL)");
    for (const agent of retiredConfigExtraUsageAgents(db))
      db.run("INSERT INTO extra_usage_import VALUES(?)", [agent]);
  },
  sql: `
CREATE TEMP TABLE IF NOT EXISTS extra_usage_import(agent TEXT NOT NULL);
CREATE TABLE runner_agent_policy_extra (
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
INSERT INTO runner_agent_policy_extra
SELECT runner_id,agent,ready,auth_expired,quota_state,resets_at,cooldown_until,resolved_model,
 last_used_at,virtual_finish,agent IN (SELECT agent FROM temp.extra_usage_import)
FROM runner_agent_policy;
DROP TABLE temp.extra_usage_import;
DROP TABLE runner_agent_policy;
ALTER TABLE runner_agent_policy_extra RENAME TO runner_agent_policy;

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

CREATE TABLE runner_execution_usage_extra (
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
INSERT INTO runner_execution_usage_extra
SELECT command_id,runner_id,owner_user_id,item_id,run_id,agent,model,role,purpose,started_at,
 ended_at,outcome,resolved_model,output_bytes,resets_at,placement_reason,account_policy_revision,
 account_fallback
FROM runner_execution_usage;
DROP TABLE runner_execution_usage;
ALTER TABLE runner_execution_usage_extra RENAME TO runner_execution_usage;
CREATE INDEX runner_usage_item ON runner_execution_usage(item_id,ended_at);
CREATE INDEX runner_usage_runner_ended ON runner_execution_usage(runner_id, ended_at);
`,
};
