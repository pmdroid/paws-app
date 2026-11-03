import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261103T0300_runner_event_sealed",
  sql: `ALTER TABLE runner_event ADD COLUMN key_id TEXT;
ALTER TABLE runner_event ADD COLUMN payload_sha256 TEXT;
ALTER TABLE runner_event ADD COLUMN type TEXT;
ALTER TABLE runner_event ADD COLUMN handed_over INTEGER;
ALTER TABLE runner_event ADD COLUMN reason TEXT;
CREATE INDEX runner_event_type ON runner_event(run_id,generation,type);
INSERT OR IGNORE INTO job(queue,job_key,priority,run_at,max_attempts,created_at)
SELECT 'runner-events.encrypt','runner-events.encrypt',9,
  CAST(strftime('%s','now') AS INTEGER)*1000,1000,CAST(strftime('%s','now') AS INTEGER)*1000
WHERE EXISTS(SELECT 1 FROM runner_event);`,
};
