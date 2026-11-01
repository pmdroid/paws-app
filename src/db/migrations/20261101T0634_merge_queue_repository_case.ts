import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261101T0634_merge_queue_repository_case",
  sql: `UPDATE merge_queue_entry SET repository = lower(repository);`,
};
