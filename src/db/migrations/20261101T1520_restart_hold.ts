import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261101T1520_restart_hold",
  sql: `
CREATE TABLE restart_hold (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  requested_at INTEGER NOT NULL
) STRICT;
INSERT INTO restart_hold (item_id, session_id, requested_at)
SELECT i.id, i.session_key, 0 FROM work_item i
WHERE i.session_key IS NOT NULL AND i.state IN ('recovering', 'awaiting_input')
  AND (
    EXISTS (SELECT 1 FROM question q WHERE q.item_id = i.id AND q.session_id = i.session_key
      AND q.reason = 'restart' AND q.status IN ('open', 'queued') AND q.cancelled_at IS NULL)
    OR EXISTS (SELECT 1 FROM job j WHERE j.queue = 'item.ask'
      AND j.job_key LIKE 'restart-ask:' || i.id || ':%'
      AND j.status IN ('pending', 'running', 'cancelled'))
  );
CREATE TRIGGER restart_hold_release AFTER UPDATE OF state ON work_item
WHEN NEW.state NOT IN ('recovering', 'awaiting_input')
BEGIN
  DELETE FROM restart_hold WHERE item_id = NEW.id;
END;`,
};
