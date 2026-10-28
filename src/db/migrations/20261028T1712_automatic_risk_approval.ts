import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261028T1712_automatic_risk_approval",
  sql: `CREATE TABLE automatic_risk_approval (
    item_id TEXT NOT NULL REFERENCES work_item(id),
    head TEXT NOT NULL,
    approved_by TEXT NOT NULL,
    evidence_ids TEXT NOT NULL,
    approved_at INTEGER NOT NULL,
    PRIMARY KEY (item_id, head)
  ) STRICT;`,
};
