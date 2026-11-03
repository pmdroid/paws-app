import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261103T0431_command_account_policy",
  sql: `ALTER TABLE runner_command_account ADD COLUMN policy_revision TEXT
 CHECK(policy_revision IS NULL OR length(policy_revision) BETWEEN 1 AND 64);`,
};
