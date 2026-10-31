import type { Migration } from "../migration";

/**
 * The Linear issue filed from a pre-existing review finding, one per finding key: the
 * repository, path, line range and finding text. The same finding on another item reads it.
 */
export const migration: Migration = {
  id: "20261028T0344_review_finding_issue",
  sql: `CREATE TABLE review_finding_issue (
  key TEXT PRIMARY KEY CHECK(length(key)=64),
  repository TEXT NOT NULL,
  path TEXT NOT NULL,
  lines TEXT NOT NULL,
  linear_issue_id TEXT NOT NULL,
  identifier TEXT NOT NULL,
  url TEXT,
  item_id TEXT,
  filed_by TEXT,
  filed_at INTEGER NOT NULL
);`,
};
