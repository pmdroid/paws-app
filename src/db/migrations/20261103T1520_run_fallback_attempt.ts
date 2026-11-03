import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261103T1520_run_fallback_attempt",
  sql: `CREATE TABLE run_fallback_attempt (
  run_id TEXT NOT NULL REFERENCES run(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL CHECK(length(call_id) BETWEEN 1 AND 300),
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 1 AND 256),
  policy_key TEXT NOT NULL CHECK(length(policy_key) BETWEEN 1 AND 2000),
  outcome TEXT NOT NULL CHECK(outcome IN ('failed','handed_over','usage_limit')),
  runner_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>=0),
  excluded_key TEXT NOT NULL CHECK(length(excluded_key)<=300),
  account_id TEXT,
  binding_id TEXT,
  recorded_at INTEGER NOT NULL,
  closed_at INTEGER,
  PRIMARY KEY(run_id,call_id,ordinal)
) STRICT;
CREATE UNIQUE INDEX run_fallback_attempt_open
  ON run_fallback_attempt(run_id,call_id,runner_id,generation,excluded_key,outcome)
  WHERE closed_at IS NULL;`,
};
