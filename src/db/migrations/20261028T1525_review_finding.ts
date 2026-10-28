import type { Migration } from "../migration";

/**
 * One row per distinct non-blocking review finding, keyed by `reviewFindingKey` (repository, path,
 * line range and normalized text), and one `review_finding_item` row per item that reported it.
 * Enqueues the one-time job that fills them from the review evidence of runs Closeout accepted
 * before this table existed, when there are any.
 */
export const migration: Migration = {
  id: "20261028T1525_review_finding",
  sql: `
CREATE TABLE review_finding (
  id INTEGER PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  repository TEXT NOT NULL,
  path TEXT NOT NULL,
  lines TEXT NOT NULL,
  first_line INTEGER,
  severity TEXT NOT NULL CHECK (severity IN ('P0', 'P1', 'P2', 'P3')),
  review TEXT NOT NULL,
  text TEXT NOT NULL,
  bug_class TEXT NOT NULL,
  why TEXT NOT NULL CHECK (why IN ('pre-existing', 'below failOn')),
  first_item_id TEXT NOT NULL REFERENCES work_item(id),
  first_head TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_item_id TEXT NOT NULL REFERENCES work_item(id),
  last_head TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filed', 'dismissed', 'gone')),
  status_by TEXT,
  status_at INTEGER,
  status_reason TEXT,
  filed_issue TEXT
) STRICT;
CREATE INDEX review_finding_last_seen ON review_finding(status, last_seen_at DESC);
CREATE INDEX review_finding_path ON review_finding(repository, review, path);
CREATE TABLE review_finding_item (
  finding_id INTEGER NOT NULL REFERENCES review_finding(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES work_item(id),
  head_sha TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (finding_id, item_id)
) STRICT;
CREATE INDEX review_finding_item_item ON review_finding_item(item_id);
INSERT OR IGNORE INTO job(queue,job_key,priority,run_at,max_attempts,created_at)
SELECT 'review-findings.backfill','review-findings.backfill',9,
  CAST(strftime('%s','now') AS INTEGER)*1000,10,CAST(strftime('%s','now') AS INTEGER)*1000
WHERE EXISTS(SELECT 1 FROM closeout_progress WHERE decision = 'accepted');
`,
};
