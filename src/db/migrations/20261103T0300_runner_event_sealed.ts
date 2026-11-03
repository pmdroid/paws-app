import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261103T0300_runner_event_sealed",
  sql: `ALTER TABLE runner_event ADD COLUMN key_id TEXT;
ALTER TABLE runner_event ADD COLUMN payload_sha256 TEXT;
ALTER TABLE runner_event ADD COLUMN type TEXT;
ALTER TABLE runner_event ADD COLUMN handed_over INTEGER;
ALTER TABLE runner_event ADD COLUMN reason TEXT;
CREATE INDEX runner_event_type ON runner_event(run_id,generation,type);
UPDATE runner_event SET type=json_extract(payload,'$.type'),
  handed_over=CASE WHEN json_extract(payload,'$.type') IN ('handover','handover_interrupted')
    THEN json_extract(payload,'$.handedOver') END,
  reason=CASE WHEN json_extract(payload,'$.type') IN ('handover','handover_interrupted')
    THEN json_extract(payload,'$.reason') END
WHERE (run_id,generation) IN (SELECT run_id,generation FROM runner_work WHERE ended_at IS NULL);
INSERT OR IGNORE INTO job(queue,job_key,priority,run_at,max_attempts,created_at)
SELECT 'runner-events.encrypt','runner-events.encrypt',9,
  CAST(strftime('%s','now') AS INTEGER)*1000,1000,CAST(strftime('%s','now') AS INTEGER)*1000
WHERE EXISTS(SELECT 1 FROM runner_event);`,
};
