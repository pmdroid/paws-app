import { teamRepositoryAllowedSql } from "./repository-catalog";
import type { Database } from "bun:sqlite";
import { workspaceMember } from "./workspace";
import { getLinearSessionAccess } from "./linear-access";

export function workspaceSessionIds(
  db: Database,
  workspaceId: string,
  userId: string,
  clientId: string,
): string[] {
  const member = workspaceMember(db, workspaceId, userId);
  if (!member?.active) return [];
  return db
    .query<{ session_id: string }, [string, string, number, string]>(
      `SELECT s.session_id FROM linear_session s JOIN workspace w ON w.linear_organization_id=s.organization_id
      WHERE w.id=? AND s.oauth_client_id=? AND s.installation_observed_at IS NOT NULL
      AND s.team_id IS NOT NULL AND (?=1 OR EXISTS(
        SELECT 1 FROM workspace_user_team t WHERE t.workspace_id=w.id AND t.user_id=? AND t.team_id=s.team_id
      )) AND NOT EXISTS(
        SELECT 1 FROM work_item i JOIN work_item_repository r ON r.item_id=i.id
        WHERE i.session_key=s.session_id AND NOT ${teamRepositoryAllowedSql("w.id", "s.team_id", "lower(r.owner || '/' || r.repo)")}
      ) ORDER BY s.session_id`,
    )
    .all(workspaceId, clientId, member.role === "admin" ? 1 : 0, userId)
    .map((row) => row.session_id)
    .filter((id) => getLinearSessionAccess(db, id) === "allowed");
}
