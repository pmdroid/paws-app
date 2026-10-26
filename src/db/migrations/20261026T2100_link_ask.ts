import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261026T2100_link_ask",
  sql: `
CREATE TABLE link_ask (
  question_id TEXT PRIMARY KEY REFERENCES question(id),
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bypass', 'screenshots', 'risk', 'question')),
  head_commit TEXT NOT NULL,
  link TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  answerers TEXT NOT NULL CHECK (json_valid(answerers)),
  created_at INTEGER NOT NULL,
  decision TEXT CHECK (decision IN ('approve', 'changes', 'answer')),
  note TEXT,
  decided_by TEXT,
  decided_at INTEGER,
  closed_reason TEXT CHECK (closed_reason IN ('decided', 'guidance', 'head_moved', 'cancelled')),
  closed_at INTEGER
) STRICT;
CREATE INDEX link_ask_item_open ON link_ask (item_id, closed_at);
`,
};
