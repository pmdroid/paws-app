import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261105T1706_runner_host_agent_user",
  sql: `ALTER TABLE runner_host_status ADD COLUMN agent_user TEXT CHECK(agent_user IN ('runner','paws-agent'));`,
};
