import type { Migration } from "../migration";

export const migration: Migration = {
  id: "20261028T1929_workspace_member_revocation",
  sql: `
ALTER TABLE workspace_member ADD COLUMN revoked_at INTEGER;
ALTER TABLE workspace_member ADD COLUMN revoked_by TEXT REFERENCES workspace_user(id);
CREATE TRIGGER revoke_workspace_member_access AFTER UPDATE OF revoked_at ON workspace_member
WHEN NEW.revoked_at IS NOT NULL
BEGIN
  DELETE FROM workspace_session WHERE workspace_id=NEW.workspace_id AND user_id=NEW.user_id;
  UPDATE runner SET status='revoked',revoked_at=NEW.revoked_at,fence=fence+1
    WHERE workspace_id=NEW.workspace_id AND owner_user_id=NEW.user_id AND revoked_at IS NULL;
  UPDATE runner_certificate SET revoked_at=NEW.revoked_at WHERE revoked_at IS NULL
    AND runner_id IN (SELECT id FROM runner WHERE workspace_id=NEW.workspace_id AND owner_user_id=NEW.user_id);
END;
`,
};
