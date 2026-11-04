import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261104T1530_checkpoint_ref_cleanup",
  sql: `CREATE TRIGGER checkpoint_ref_cleanup AFTER UPDATE OF state ON work_item
WHEN NEW.state IN ('completed','merged','cancelled')
  AND OLD.state NOT IN ('completed','merged','cancelled')
  AND NEW.branch_name IS NOT NULL AND NEW.branch_name != ''
BEGIN
  INSERT OR IGNORE INTO job(queue,job_key,payload,run_at,max_attempts,created_at)
  VALUES('github.delete_checkpoint_ref',
    'delete-checkpoint-ref:' || NEW.id || ':' || NEW.version,
    json_object('checkpointRefFor',NEW.id),0,5,
    CAST(strftime('%s','now') AS INTEGER)*1000);
END;`,
};
