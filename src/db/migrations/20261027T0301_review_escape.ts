import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261027T0301_review_escape",
  sql: `
CREATE TABLE review_escape (
  id INTEGER PRIMARY KEY,
  trigger_key TEXT NOT NULL UNIQUE,
  item_id TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('ci', 'review', 'comment')),
  accepted_head TEXT NOT NULL,
  pull_number INTEGER,
  detail TEXT NOT NULL CHECK (json_valid(detail)),
  recorded_at INTEGER NOT NULL,
  fix_head TEXT,
  files TEXT CHECK (files IS NULL OR json_valid(files)),
  is_escape INTEGER CHECK (is_escape IN (0, 1)),
  not_escape_reason TEXT CHECK (not_escape_reason IN ('flake', 'tests_docs_format', 'no_change', 'unreviewed')),
  settled_at INTEGER
) STRICT;
CREATE INDEX review_escape_item_open ON review_escape (item_id, settled_at);
`,
};
