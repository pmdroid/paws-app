import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261031T1931_risk_auto_context",
  sql: `CREATE TABLE risk_auto_context (
    item_id TEXT NOT NULL REFERENCES work_item(id) ON DELETE CASCADE,
    head TEXT NOT NULL,
    context TEXT NOT NULL,
    PRIMARY KEY (item_id, head)
  );`,
};
