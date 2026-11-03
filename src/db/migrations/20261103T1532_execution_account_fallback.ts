import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261103T1532_execution_account_fallback",
  sql: `ALTER TABLE runner_execution_usage ADD COLUMN account_fallback TEXT
 CHECK(account_fallback IS NULL OR length(account_fallback) BETWEEN 1 AND 500);`,
};
