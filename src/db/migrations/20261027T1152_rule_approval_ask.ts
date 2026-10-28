import type { Migration } from "../migration";

/**
 * Link asks gain the `rule` kind: a failed rule set to `onFail: approve` waits
 * for a person, who approves the break or sends it back to the agent.
 */
export const migration: Migration = {
  id: "20261027T1152_rule_approval_ask",
  sql: `
CREATE TABLE link_ask_next (
  question_id TEXT PRIMARY KEY REFERENCES question(id),
  item_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('bypass', 'screenshots', 'risk', 'question', 'rounds', 'rule')),
  head_commit TEXT NOT NULL,
  link TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  answerers TEXT NOT NULL CHECK (json_valid(answerers)),
  created_at INTEGER NOT NULL,
  decision TEXT CHECK (decision IN ('approve', 'changes', 'answer', 'rethink', 'continue', 'stop')),
  note TEXT,
  decided_by TEXT,
  decided_at INTEGER,
  closed_reason TEXT CHECK (closed_reason IN ('decided', 'guidance', 'head_moved', 'cancelled')),
  closed_at INTEGER,
  rounds TEXT CHECK (rounds IS NULL OR json_valid(rounds))
) STRICT;
INSERT INTO link_ask_next SELECT question_id, item_id, kind, head_commit, link, title, detail,
  answerers, created_at, decision, note, decided_by, decided_at, closed_reason, closed_at, rounds
FROM link_ask;
DROP TABLE link_ask;
ALTER TABLE link_ask_next RENAME TO link_ask;
CREATE INDEX link_ask_item_open ON link_ask (item_id, closed_at);
`,
};
