import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261030T2114_github_queue_watch",
  sql: `CREATE TABLE github_queue_watch (
    item_id TEXT PRIMARY KEY REFERENCES work_item(id) ON DELETE CASCADE
  );`,
};
