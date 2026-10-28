import type { Migration } from "../migration";

// PAS-889. A re-delegated issue continues the branch and pull request of its earlier item.
// `branch` is the pushed branch the item takes over, `paws/<key>`.
export const migration: Migration = {
  id: "20261028T1507_item_continuation",
  sql: `
CREATE TABLE item_continuation (
  item_id TEXT PRIMARY KEY REFERENCES work_item(id),
  previous_item_id TEXT NOT NULL REFERENCES work_item(id),
  branch TEXT NOT NULL CHECK (branch LIKE 'paws/%')
) STRICT;
CREATE INDEX item_continuation_previous ON item_continuation(previous_item_id);`,
};
