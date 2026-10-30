import type { Migration } from "../migration";

/** A repository's Closeout policy uses keys the lowest online runner is too old to know. */
export const migration: Migration = {
  id: "20261028T1542_policy_runner_warning",
  sql: `
CREATE TABLE policy_runner_warning (
  repository TEXT PRIMARY KEY,
  policy_digest TEXT NOT NULL,
  runner_version TEXT NOT NULL,
  keys TEXT NOT NULL,
  checked_at INTEGER NOT NULL
) STRICT;
`,
};
