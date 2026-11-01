import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261101T0640_push_conflict_returns",
  sql: `
CREATE TABLE rebase_return_new (
  job_id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  candidate TEXT,
  reason TEXT NOT NULL CHECK(reason IN ('merge','github_queue','linear','push')),
  base TEXT,
  files TEXT CHECK(files IS NULL OR json_valid(files)),
  recorded_at INTEGER
) STRICT;
INSERT INTO rebase_return_new SELECT job_id,item_id,candidate,reason,base,files,recorded_at FROM rebase_return;
DROP TABLE rebase_return;
ALTER TABLE rebase_return_new RENAME TO rebase_return;
CREATE INDEX rebase_return_item ON rebase_return(item_id,job_id);
`,
};
