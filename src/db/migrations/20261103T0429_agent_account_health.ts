import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261103T0429_agent_account_health",
  sql: `
ALTER TABLE agent_account ADD COLUMN concurrency INTEGER CHECK(concurrency IS NULL OR concurrency BETWEEN 1 AND 64);

CREATE TABLE IF NOT EXISTS agent_account_health (
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
CREATE INDEX IF NOT EXISTS agent_account_health_agent
 ON agent_account_health(workspace_id,agent,next_check_at);
`,
};
