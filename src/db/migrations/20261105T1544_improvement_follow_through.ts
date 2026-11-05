import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261105T1544_improvement_follow_through",
  sql: `
CREATE TABLE improvement_issue_sync (
  improvement_id TEXT PRIMARY KEY REFERENCES improvement(id),
  issue_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('available','missing','unauthorized','unavailable')),
  state_type TEXT,
  team_id TEXT,
  delegated INTEGER CHECK(delegated IS NULL OR delegated IN (0,1)),
  observed_at INTEGER NOT NULL,
  confirmed_at INTEGER
) STRICT;

CREATE TABLE improvement_delegation (
  improvement_id TEXT PRIMARY KEY REFERENCES improvement(id),
  issue_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('requested','started','existing','failed')),
  session_id TEXT,
  error TEXT,
  attempts INTEGER NOT NULL CHECK(attempts >= 0),
  lease_expires_at INTEGER,
  actor TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(state <> 'requested' OR lease_expires_at IS NOT NULL)
) STRICT;

CREATE TABLE improvement_sweep (
  improvement_id TEXT PRIMARY KEY REFERENCES improvement(id),
  checked_at INTEGER NOT NULL
) STRICT;

CREATE TABLE improvement_work (
  improvement_id TEXT PRIMARY KEY REFERENCES improvement(id),
  issue_id TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  bound_at INTEGER NOT NULL
) STRICT;

CREATE TABLE improvement_action (
  id INTEGER PRIMARY KEY,
  improvement_id TEXT NOT NULL REFERENCES improvement(id),
  action TEXT NOT NULL CHECK(action IN
    ('delegate','verify','contradict','criterion','acknowledge','redelegate','return_to_review',
     'follow_work')),
  version INTEGER NOT NULL,
  prior TEXT NOT NULL CHECK(json_valid(prior)),
  detail TEXT NOT NULL CHECK(json_valid(detail)),
  actor TEXT NOT NULL,
  at INTEGER NOT NULL
) STRICT;
CREATE INDEX improvement_action_improvement ON improvement_action(improvement_id, id);
CREATE TRIGGER improvement_action_immutable BEFORE UPDATE ON improvement_action
BEGIN SELECT RAISE(ABORT, 'improvement follow-through actions are immutable'); END;
`,
};
