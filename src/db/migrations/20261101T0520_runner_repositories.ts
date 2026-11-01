import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261101T0520_runner_repositories",
  sql: `CREATE TABLE runner_repositories (
    runner_id TEXT PRIMARY KEY REFERENCES runner(id) ON DELETE CASCADE,
    repositories TEXT CHECK (repositories IS NULL OR json_valid(repositories)),
    reported_at INTEGER NOT NULL
  ) STRICT;`,
};
