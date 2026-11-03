import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261103T0621_execution_account_policy",
  sql: `ALTER TABLE runner_execution_usage ADD COLUMN account_policy_revision TEXT
 CHECK(account_policy_revision IS NULL OR length(account_policy_revision) BETWEEN 1 AND 64);`,
};
