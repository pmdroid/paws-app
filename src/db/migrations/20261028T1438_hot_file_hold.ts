import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261028T1438_hot_file_hold",
  sql: `
CREATE TABLE candidate_paths (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  head_sha TEXT NOT NULL,
  paths TEXT NOT NULL CHECK (json_valid(paths)),
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, head_sha)
) STRICT;
CREATE INDEX candidate_paths_item ON candidate_paths (item_id, recorded_at);
CREATE TABLE item_hold_next (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  reason TEXT NOT NULL CHECK (reason IN ('blocked','project','reconciling','snapshot','cap','slot','workspace','overlap')),
  blockers TEXT NOT NULL CHECK (json_valid(blockers)),
  files TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files))
) STRICT;
INSERT INTO item_hold_next(item_id,reason,blockers) SELECT item_id,reason,blockers FROM item_hold;
DROP TABLE item_hold;
ALTER TABLE item_hold_next RENAME TO item_hold;
`,
};
