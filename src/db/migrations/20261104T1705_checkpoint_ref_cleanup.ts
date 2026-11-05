import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261104T1705_checkpoint_ref_cleanup",
  sql: `CREATE TABLE checkpoint_ref_cleanup (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id) ON DELETE CASCADE,
  ended_at INTEGER NOT NULL
) STRICT;
CREATE TRIGGER checkpoint_ref_cleanup_ended AFTER UPDATE OF state ON work_item
WHEN NEW.state IN ('completed','merged','cancelled')
  AND OLD.state NOT IN ('completed','merged','cancelled')
  AND NEW.branch_name IS NOT NULL AND NEW.branch_name != ''
BEGIN
  INSERT OR REPLACE INTO checkpoint_ref_cleanup(item_id,ended_at)
  VALUES(NEW.id, CAST(strftime('%s','now') AS INTEGER)*1000);
END;`,
};
