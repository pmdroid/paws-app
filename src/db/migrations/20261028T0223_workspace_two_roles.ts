import type { Migration } from "../migration";

/**
 * Two workspace roles, admin and member. An owner becomes an admin. An observer loses access: its
 * row turns into an inactive member and its sessions end, so it can no longer sign in or act.
 */
export const migration: Migration = {
  id: "20261028T0223_workspace_two_roles",
  sql: `
DELETE FROM workspace_session WHERE EXISTS (
  SELECT 1 FROM workspace_member m WHERE m.workspace_id=workspace_session.workspace_id
  AND m.user_id=workspace_session.user_id AND m.role='observer'
);
UPDATE workspace_member SET role='member',active=0 WHERE role='observer';
UPDATE workspace_member SET role='admin' WHERE role='owner';
UPDATE workspace_member SET manual_role='admin' WHERE manual_role='owner';
UPDATE workspace_member SET manual_role='member' WHERE manual_role='observer';
`,
};
