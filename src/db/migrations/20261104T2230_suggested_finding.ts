import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261104T2230_suggested_finding",
  sql: `
CREATE TABLE suggested_finding (
  item_id TEXT NOT NULL REFERENCES work_item(id),
  finding_id TEXT NOT NULL,
  review_id TEXT NOT NULL,
  location TEXT NOT NULL,
  severity TEXT NOT NULL,
  explanation TEXT NOT NULL,
  handed_at INTEGER NOT NULL,
  decision TEXT CHECK(decision IN ('fixed','declined')),
  reason TEXT,
  head TEXT,
  decided_at INTEGER,
  PRIMARY KEY(item_id, finding_id),
  CHECK((decision IS NULL) = (decided_at IS NULL))
) STRICT;
CREATE TABLE suggestion_turn (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  outcome TEXT NOT NULL CHECK(outcome IN ('started','skipped')),
  reason TEXT,
  head TEXT NOT NULL,
  recorded_at INTEGER NOT NULL
) STRICT;
`,
};
