import type { Database } from "bun:sqlite";
import { immediate } from "./tx";

export type CatalogEntry = {
  owner: string;
  repo: string;
  remoteUrl: string;
  defaultBranch: string;
};

export function listRepositoryCatalog(db: Database): CatalogEntry[] {
  return db
    .query<CatalogEntry, []>(
      `SELECT owner, repo, remote_url AS remoteUrl, default_branch AS defaultBranch
       FROM repository_catalog ORDER BY repository`,
    )
    .all();
}

export async function refreshRepositoryCatalog(
  db: Database,
  list: () => Promise<readonly CatalogEntry[]>,
  now = Date.now(),
): Promise<boolean> {
  let entries: readonly CatalogEntry[];
  try {
    entries = await list();
  } catch {
    return false;
  }
  immediate(db, () => {
    db.run("DELETE FROM repository_catalog");
    for (const entry of entries)
      db.run(
        `INSERT OR REPLACE INTO repository_catalog(repository, owner, repo, remote_url, default_branch, refreshed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          `${entry.owner}/${entry.repo}`.toLowerCase(),
          entry.owner,
          entry.repo,
          entry.remoteUrl,
          entry.defaultBranch,
          now,
        ],
      );
  });
  return true;
}

export function teamRepositoryAllowedSql(
  workspaceSql: string,
  teamSql: string,
  repositorySql: string,
): string {
  return `(EXISTS (SELECT 1 FROM workspace_repository scope_link WHERE scope_link.workspace_id = ${workspaceSql} AND scope_link.team_id = ${teamSql} AND lower(scope_link.repository) = ${repositorySql}) OR (NOT EXISTS (SELECT 1 FROM workspace_repository scope_team WHERE scope_team.workspace_id = ${workspaceSql} AND scope_team.team_id = ${teamSql}) AND EXISTS (SELECT 1 FROM repository_catalog scope_catalog WHERE scope_catalog.repository = ${repositorySql})))`;
}

export function listTeamRepositories(db: Database, sessionId: string): string[] {
  return db
    .query<{ repository: string }, [string]>(
      `SELECT lower(p.repository) AS repository FROM workspace_repository p
       JOIN workspace w ON w.id=p.workspace_id
       JOIN linear_session s ON s.organization_id=w.linear_organization_id AND s.team_id=p.team_id
       WHERE s.session_id=? ORDER BY repository`,
    )
    .all(sessionId)
    .map((row) => row.repository);
}
