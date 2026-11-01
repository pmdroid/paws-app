import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261101T0759_restart_decision",
  sql: `CREATE TABLE restart_decision (
    item_id TEXT PRIMARY KEY REFERENCES work_item(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    job_key TEXT NOT NULL,
    question_id TEXT REFERENCES question(id)
  );
  INSERT INTO restart_decision(item_id, session_id, job_key)
  SELECT i.id, i.session_key, 'restart-ask:' || i.id || ':' || i.version
  FROM work_item i WHERE i.session_key IS NOT NULL
    AND i.state IN ('running','recovering','awaiting_input')
    AND (EXISTS (SELECT 1 FROM question q WHERE q.item_id=i.id
      AND q.session_id=i.session_key AND q.reason='restart'
      AND q.status IN ('open','queued') AND q.cancelled_at IS NULL)
    OR EXISTS (SELECT 1 FROM job j WHERE json_extract(j.payload,'$.itemId')=i.id
      AND j.queue='item.ask' AND json_extract(j.payload,'$.reason')='restart'
      AND j.item_version=i.version));
  UPDATE restart_decision SET question_id=(SELECT q.id FROM question q
    WHERE q.item_id=restart_decision.item_id AND q.session_id=restart_decision.session_id
      AND q.reason='restart' AND q.status IN ('open','queued') AND q.cancelled_at IS NULL
    ORDER BY q.created_at DESC LIMIT 1);`,
};
