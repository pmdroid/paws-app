import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261101T0851_restart_decision_recovery",
  sql: `
  INSERT OR IGNORE INTO restart_decision(item_id,session_id,job_key)
  SELECT i.id,i.session_key,'restart-ask:' || i.id || ':' || i.version
  FROM work_item i WHERE i.session_key IS NOT NULL
    AND i.state IN ('running','recovering','verifying','awaiting_input')
    AND (EXISTS (SELECT 1 FROM question q WHERE q.item_id=i.id AND q.session_id=i.session_key
      AND q.reason='restart' AND q.cancelled_at IS NULL AND (q.run_id IS NULL OR q.run_id=i.current_run_id)
      AND (q.status IN ('open','queued') OR (q.status='answered' AND q.handoff_version IS NULL)))
    OR EXISTS (SELECT 1 FROM job j WHERE json_extract(j.payload,'$.itemId')=i.id
      AND j.queue='item.ask' AND json_extract(j.payload,'$.reason')='restart' AND j.item_version=i.version));
  UPDATE restart_decision SET question_id=(SELECT q.id FROM question q
    JOIN work_item i ON i.id=q.item_id
    WHERE q.item_id=restart_decision.item_id AND q.session_id=restart_decision.session_id
      AND q.reason='restart' AND q.cancelled_at IS NULL AND (q.run_id IS NULL OR q.run_id=i.current_run_id)
      AND (q.status IN ('open','queued') OR (q.status='answered' AND q.handoff_version IS NULL))
    ORDER BY CASE WHEN q.id=restart_decision.question_id AND q.status='answered' THEN 0
      WHEN q.status='open' THEN 1 WHEN q.status='answered' THEN 2 ELSE 3 END,
      q.created_at DESC,q.id DESC LIMIT 1);
  DELETE FROM restart_decision WHERE item_id IN (SELECT id FROM work_item
    WHERE state NOT IN ('running','recovering','verifying','awaiting_input','paused'));
  CREATE TRIGGER restart_decision_lifecycle AFTER UPDATE OF state ON work_item
  WHEN NEW.state NOT IN ('running','recovering','verifying','awaiting_input','paused')
    OR (OLD.state='paused' AND NEW.state='running')
  BEGIN DELETE FROM restart_decision WHERE item_id=NEW.id; END;`,
};
