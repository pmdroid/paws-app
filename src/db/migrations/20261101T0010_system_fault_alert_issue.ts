import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261101T0010_system_fault_alert_issue",
  sql: `CREATE TABLE system_fault_alert_issue (
    id TEXT PRIMARY KEY,
    issue_id TEXT NOT NULL
  ) STRICT;`,
};
