import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261031T2348_system_fault_alert",
  sql: `CREATE TABLE system_fault_alert (
    fault_class TEXT PRIMARY KEY,
    epoch TEXT NOT NULL
  ) STRICT;`,
};
