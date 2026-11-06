import { journal } from "../journal";
import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261106T0855_retire_named_agent_accounts",
  guard: (db) => {
    for (const account of db
      .query<{ id: string; workspaceId: string; agent: string; label: string }, []>(
        `SELECT id,workspace_id AS workspaceId,agent,label FROM agent_account
         WHERE legacy=0 AND enabled=1 ORDER BY rowid`,
      )
      .all())
      journal(
        `agent account ${account.id} (${account.agent} "${account.label}", workspace ${account.workspaceId}) disabled: named accounts were replaced by per-runner sign-in`,
      );
  },
  sql: `UPDATE agent_account
SET enabled=0,updated_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
WHERE legacy=0 AND enabled=1;`,
};
