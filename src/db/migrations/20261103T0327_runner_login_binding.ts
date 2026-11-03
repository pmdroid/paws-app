import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261103T0327_runner_login_binding",
  sql: `
ALTER TABLE runner_login ADD COLUMN binding_id TEXT REFERENCES agent_account_binding(id);
CREATE INDEX IF NOT EXISTS runner_login_binding ON runner_login(binding_id) WHERE binding_id IS NOT NULL;
`,
};
