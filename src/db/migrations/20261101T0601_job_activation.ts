import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261101T0601_job_activation",
  sql: `
ALTER TABLE job ADD COLUMN activation_id INTEGER NOT NULL DEFAULT 0;
CREATE TABLE job_activation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL REFERENCES job(id) ON DELETE CASCADE
) STRICT;
INSERT INTO job_activation (id,job_id) SELECT id,id FROM job;
UPDATE job SET activation_id=id;
CREATE TRIGGER job_initial_activation AFTER INSERT ON job BEGIN
  INSERT INTO job_activation (job_id) VALUES (NEW.id);
  UPDATE job SET activation_id=last_insert_rowid() WHERE id=NEW.id;
END;

ALTER TABLE rebase_return RENAME TO rebase_return_before_activation;
CREATE TABLE rebase_return (
  job_id INTEGER NOT NULL,
  activation_id INTEGER NOT NULL,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  candidate TEXT,
  reason TEXT NOT NULL CHECK(reason IN ('merge','github_queue','linear')),
  base TEXT,
  files TEXT CHECK(files IS NULL OR json_valid(files)),
  recorded_at INTEGER,
  PRIMARY KEY (job_id,activation_id)
) STRICT;
INSERT INTO rebase_return SELECT job_id,job_id,item_id,candidate,reason,base,files,recorded_at
  FROM rebase_return_before_activation;
DROP TABLE rebase_return_before_activation;
CREATE INDEX rebase_return_item ON rebase_return (item_id,activation_id);

ALTER TABLE closeout_retry_window RENAME TO closeout_retry_window_before_activation;
CREATE TABLE closeout_retry_window (
  job_id INTEGER NOT NULL REFERENCES job(id),
  activation_id INTEGER NOT NULL,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  retry_baseline TEXT NOT NULL CHECK(json_valid(retry_baseline)),
  PRIMARY KEY (job_id,activation_id)
);
INSERT INTO closeout_retry_window SELECT job_id,job_id,item_id,retry_baseline
  FROM closeout_retry_window_before_activation;
DROP TABLE closeout_retry_window_before_activation;
`,
};
