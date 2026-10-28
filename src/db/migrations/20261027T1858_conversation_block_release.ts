import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261027T1858_conversation_block_release",
  sql: `ALTER TABLE linear_conversation ADD COLUMN blocked_at INTEGER;
ALTER TABLE runner ADD COLUMN live_reported_at INTEGER;`,
};
