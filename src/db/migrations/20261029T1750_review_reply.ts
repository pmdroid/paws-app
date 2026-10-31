import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261029T1750_review_reply",
  sql: `
CREATE TABLE review_reply (
  id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL,
  restart_key TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number >= 1),
  pull_number INTEGER NOT NULL,
  target TEXT NOT NULL CHECK (target IN ('thread', 'review', 'conversation')),
  comment_id INTEGER,
  thread_id TEXT,
  author TEXT,
  excerpt TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  outcome TEXT CHECK (outcome IN ('fixed', 'answered', 'not_changed', 'unreported')),
  reply TEXT,
  reported_at INTEGER,
  replied_at INTEGER,
  resolved_at INTEGER,
  UNIQUE (restart_key, number)
) STRICT;
CREATE INDEX review_reply_item_open ON review_reply (item_id, replied_at);
`,
};
