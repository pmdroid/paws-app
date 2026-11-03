import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261103T1605_linear_comment",
  sql: `CREATE TABLE linear_comment (
  comment_id TEXT PRIMARY KEY CHECK(length(comment_id) BETWEEN 1 AND 300),
  issue_id TEXT NOT NULL CHECK(length(issue_id) BETWEEN 1 AND 300),
  organization_id TEXT,
  team_id TEXT,
  author_id TEXT,
  actor_id TEXT,
  actor_type TEXT,
  bot_actor TEXT,
  on_behalf_of TEXT,
  parent_id TEXT,
  body TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('webhook','poll')),
  edited INTEGER NOT NULL DEFAULT 0 CHECK(edited IN (0,1)),
  removed_at INTEGER,
  state TEXT NOT NULL DEFAULT 'received' CHECK(state IN
    ('received','queued','delivered','answered','ignored','rejected','removed')),
  reason TEXT,
  authority TEXT CHECK(authority IS NULL OR authority IN ('person','agent')),
  item_id TEXT,
  session_id TEXT,
  generation INTEGER,
  item_version INTEGER,
  via TEXT CHECK(via IS NULL OR via IN ('brief','follow_up','restart','answer')),
  settled_at INTEGER
) STRICT;
CREATE INDEX linear_comment_issue ON linear_comment(issue_id, state);
CREATE INDEX linear_comment_item ON linear_comment(item_id, state);`,
};
