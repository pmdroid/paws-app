import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261104T0900_improvement_review_intent",
  sql: `
ALTER TABLE improvement_delivery ADD COLUMN target_team_id TEXT;
ALTER TABLE improvement_delivery ADD COLUMN content TEXT
  CHECK(content IS NULL OR json_valid(content));
CREATE TRIGGER improvement_delivery_intent_frozen BEFORE UPDATE ON improvement_delivery
WHEN OLD.operation IS NOT NEW.operation OR OLD.target_issue_id IS NOT NEW.target_issue_id
  OR OLD.target_team_id IS NOT NEW.target_team_id OR OLD.content IS NOT NEW.content
BEGIN SELECT RAISE(ABORT, 'improvement delivery intent is frozen'); END;

CREATE TABLE improvement_criterion (
  improvement_id TEXT NOT NULL REFERENCES improvement(id),
  revision INTEGER NOT NULL CHECK(revision >= 1),
  proposal_version INTEGER NOT NULL,
  criterion TEXT NOT NULL CHECK(length(criterion) BETWEEN 1 AND 1000),
  actor TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (improvement_id, revision)
) STRICT;
CREATE TRIGGER improvement_criterion_immutable BEFORE UPDATE ON improvement_criterion
BEGIN SELECT RAISE(ABORT, 'improvement criterion annotations are immutable'); END;

CREATE TABLE review_finding_issue_claim (
  key TEXT PRIMARY KEY CHECK(length(key)=64),
  finding_key TEXT NOT NULL,
  item_id TEXT,
  claimed_by TEXT,
  claimed_at INTEGER NOT NULL
) STRICT;
CREATE INDEX review_finding_issue_claim_finding ON review_finding_issue_claim(finding_key);
`,
};
