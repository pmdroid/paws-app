import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261106T1945_runner_conversation_lane",
  sql: `ALTER TABLE runner_capacity ADD COLUMN conversation INTEGER CHECK(conversation IS NULL OR conversation BETWEEN 0 AND 16);
ALTER TABLE runner_helper ADD COLUMN purpose TEXT;`,
};
