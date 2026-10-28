import { workspaceMemberUsable } from "../db";
import { isWorkspaceAdmin } from "../workspace";
import type { Database } from "bun:sqlite";
import {
  listWorkspaceMembers,
  listWorkspaceRepositories,
  teamRepositoryAllowedSql,
  type WorkItemRecord,
} from "../db";
import {
  noRepositoryDenial,
  notTeamMemberDenial,
  unmappedRepositoryDenial,
  type GitHubDenial,
} from "./github-integration";

export type TeamScope = { workspaceId: string; teamId: string };

/**
 * Whether the issue's team may use `repository`, by the same rule placement uses: a team with
 * linked repositories uses only those, and a team without links uses any catalog repository.
 * Returns null when allowed, otherwise the reason. Reads the database only.
 */
export function teamRepositoryDenial(
  db: Database,
  item: WorkItemRecord,
  scope: TeamScope,
  repository: { owner: string; repo: string },
): GitHubDenial | null {
  const name = `${repository.owner}/${repository.repo}`;
  const allowed = db
    .query<{ allowed: number }, string[]>(
      `SELECT ${teamRepositoryAllowedSql("?", "?", "?")} AS allowed`,
    )
    .get(
      scope.workspaceId,
      scope.teamId,
      name.toLowerCase(),
      scope.workspaceId,
      scope.teamId,
      name.toLowerCase(),
    );
  if (allowed?.allowed === 1) return null;
  const team = issueTeamName(db, item);
  const linked = listWorkspaceRepositories(db, scope.workspaceId).some(
    (entry) => entry.teamId === scope.teamId,
  );
  return linked
    ? unmappedRepositoryDenial(name, team)
    : noRepositoryDenial(team, workspaceAdministratorNames(db, scope.workspaceId));
}

/** The delegator is not in the issue's team in Paws. */
export function teamMemberDenial(db: Database, item: WorkItemRecord): GitHubDenial {
  return notTeamMemberDenial(issueTeamName(db, item));
}

/** Names of the workspace's active admins, from the database. */
export function workspaceAdministratorNames(db: Database, workspaceId: string): string[] {
  return listWorkspaceMembers(db, workspaceId)
    .filter((member) => workspaceMemberUsable(member) && isWorkspaceAdmin(member.role))
    .map((member) => member.name);
}

/**
 * The issue's team as Linear named it in the session webhook, or the team key from the issue
 * identifier when no stored payload names it. Never reads Linear.
 */
export function issueTeamName(db: Database, item: WorkItemRecord): string {
  const stored = item.sessionKey
    ? db
        .query<{ name: string }, [string]>(
          `SELECT json_extract(payload,'$.agentSession.issue.team.name') AS name FROM inbox_event
           WHERE session_id=? AND trim(coalesce(json_extract(payload,'$.agentSession.issue.team.name'),''))<>''
           ORDER BY received_at DESC LIMIT 1`,
        )
        .get(item.sessionKey)?.name
    : undefined;
  if (typeof stored === "string" && stored.trim() !== "") return stored.trim();
  const key = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(item.linearIdentifier)?.[1];
  return key ?? "this team";
}
