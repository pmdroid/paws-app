import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261102T0055_runner_admin_repositories",
  sql: `ALTER TABLE runner_repositories ADD COLUMN admin_repositories TEXT
    CHECK (admin_repositories IS NULL OR json_valid(admin_repositories));`,
};
