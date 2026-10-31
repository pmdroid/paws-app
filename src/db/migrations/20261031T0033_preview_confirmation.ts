import type { Migration } from "../migration";
export const migration: Migration = {
  id: "20261031T0033_preview_confirmation",
  sql: `CREATE TABLE live_preview_confirmation (
    question_id TEXT PRIMARY KEY REFERENCES question(id),
    confirmed_until INTEGER NOT NULL
  ) STRICT;`,
};
