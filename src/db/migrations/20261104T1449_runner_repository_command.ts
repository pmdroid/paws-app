import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261104T1449_runner_repository_command",
  sql: `
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
CREATE INDEX runner_repository_command_runner ON runner_repository_command(runner_id, state);
`,
};
