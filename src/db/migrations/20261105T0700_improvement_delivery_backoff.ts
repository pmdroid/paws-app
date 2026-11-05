import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261105T0700_improvement_delivery_backoff",
  sql: `
ALTER TABLE improvement_delivery ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE improvement_delivery ADD COLUMN blocked TEXT
  CHECK(blocked IS NULL OR blocked IN ('destination','unauthorized','unavailable','conflict','attempts','workspace'));
ALTER TABLE improvement_delivery ADD COLUMN retry_base INTEGER NOT NULL DEFAULT 0;

CREATE TRIGGER improvement_delivery_remote_reserved BEFORE UPDATE ON improvement_delivery
WHEN OLD.remote_id IS NOT NULL AND OLD.remote_id IS NOT NEW.remote_id
BEGIN SELECT RAISE(ABORT, 'improvement delivery remote id is reserved'); END;

DROP TRIGGER improvement_delivery_intent_frozen;
CREATE TRIGGER improvement_delivery_intent_frozen BEFORE UPDATE ON improvement_delivery
WHEN OLD.operation IS NOT NEW.operation OR OLD.target_issue_id IS NOT NEW.target_issue_id
  OR OLD.content IS NOT NEW.content
  OR (OLD.target_team_id IS NOT NEW.target_team_id AND NOT (
    OLD.operation = 'create_issue' AND OLD.state = 'failed' AND OLD.blocked = 'destination'
    AND OLD.remote_id IS NULL AND NEW.target_team_id IS NOT NULL))
BEGIN SELECT RAISE(ABORT, 'improvement delivery intent is frozen'); END;
`,
};
