import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261028T1712_finding_groups",
  sql: `
CREATE TABLE finding_group_run (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id),
 day TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
 fingerprint TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
 tokens INTEGER, group_count INTEGER NOT NULL DEFAULT 0, error TEXT,
 UNIQUE(workspace_id, day)
) STRICT;
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
CREATE INDEX finding_group_workspace ON finding_group(workspace_id,status);
`,
};
