import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261104T1729_agent_closeout_key",
  sql: `
ALTER TABLE agent_closeout_event ADD COLUMN base TEXT;
ALTER TABLE agent_closeout_event ADD COLUMN policy_digest TEXT;
ALTER TABLE agent_closeout_event ADD COLUMN clean INTEGER CHECK(clean IS NULL OR clean IN (0, 1));
`,
};
