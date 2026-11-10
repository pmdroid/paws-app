import {
  sessionIssueTeamName,
  sqliteDb,
  teamRepositoryAllowedSteps,
  workspaceMemberUsable,
  listWorkspaceMembersSteps,
  listWorkspaceRepositoriesSteps,
  type Db,
  type WorkItemRecord,
} from "../db";
import { isWorkspaceAdmin } from "../workspace";
import type { Database } from "bun:sqlite";
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
export async function teamRepositoryDenial(
  db: Database,
  item: WorkItemRecord,
  scope: TeamScope,
  repository: { owner: string; repo: string },
): Promise<GitHubDenial | null> {
  const store = sqliteDb(db);
  const name = `${repository.owner}/${repository.repo}`;
  if (
    await store.run((q) =>
      teamRepositoryAllowedSteps(q, scope.workspaceId, scope.teamId, name.toLowerCase()),
    )
  )
    return null;
  const team = issueTeamName(db, item);
  const linked = (
    await store.run((q) => listWorkspaceRepositoriesSteps(q, scope.workspaceId))
  ).some((entry) => entry.teamId === scope.teamId);
  return linked
    ? unmappedRepositoryDenial(name, team)
    : noRepositoryDenial(team, await workspaceAdministratorNames(store, scope.workspaceId));
}

/** The delegator is not in the issue's team in Paws. */
export function teamMemberDenial(db: Database, item: WorkItemRecord): GitHubDenial {
  return notTeamMemberDenial(issueTeamName(db, item));
}

/** Names of the workspace's active admins, from the database. */
export async function workspaceAdministratorNames(
  store: Db,
  workspaceId: string,
): Promise<string[]> {
  return (await store.run((q) => listWorkspaceMembersSteps(q, workspaceId)))
    .filter((member) => workspaceMemberUsable(member) && isWorkspaceAdmin(member.role))
    .map((member) => member.name);
}

/**
 * The issue's team as Linear named it in the session webhook, or the team key from the issue
 * identifier when no stored payload names it. Never reads Linear.
 */
export function issueTeamName(db: Database, item: WorkItemRecord): string {
  const stored = item.sessionKey ? sessionIssueTeamName(db, item.sessionKey) : undefined;
  if (typeof stored === "string" && stored.trim() !== "") return stored.trim();
  const key = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(item.linearIdentifier)?.[1];
  return key ?? "this team";
}
