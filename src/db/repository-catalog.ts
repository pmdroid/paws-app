import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { and, eq, sql } from "drizzle-orm";
import type { RepositoryBinding } from "../core";
import { settled, sqliteDb, type Q, type Steps } from "./db";
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

export function* listRepositoryCatalogSteps(q: Q): Steps<CatalogEntry[]> {
  const { repositoryCatalog } = q.t;
  return yield* q.all(
    q.orm
      .select({
        owner: repositoryCatalog.owner,
        repo: repositoryCatalog.repo,
        remoteUrl: repositoryCatalog.remoteUrl,
        defaultBranch: repositoryCatalog.defaultBranch,
      })
      .from(repositoryCatalog)
      .orderBy(repositoryCatalog.repository),
  );
}

export async function refreshRepositoryCatalog(
  db: Database,
  list: () => Promise<readonly CatalogEntry[]>,
  now = Date.now(),
): Promise<boolean> {
  let entries: readonly CatalogEntry[];
  try {
    entries = await list();
  } catch (error) {
    journalCaught(error, "repository-catalog.refreshRepositoryCatalog.list", null);

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

export function listRepositoryCandidates(
  db: Database,
  sessionId: string | null,
  configured: readonly RepositoryBinding[],
): RepositoryBinding[] {
  const teamLinks = sessionId ? listTeamRepositories(db, sessionId) : [];
  const candidates = [
    ...configured,
    ...listRepositoryCatalog(db),
    ...teamLinks.map((name) => {
      const [owner, repo] = name.split("/");
      return { owner: owner!, repo: repo!, remoteUrl: `https://github.com/${name}.git` };
    }),
  ];
  const seen = new Set<string>();
  return candidates
    .filter((candidate) => {
      const name = `${candidate.owner}/${candidate.repo}`.toLowerCase();
      if (seen.has(name) || (teamLinks.length > 0 && !teamLinks.includes(name))) return false;
      seen.add(name);
      return true;
    })
    .map(({ owner, repo, remoteUrl }) => ({ owner, repo, remoteUrl }));
}

function* listTeamRepositoriesSteps(q: Q, sessionId: string): Steps<string[]> {
  const { linearSession, workspace, workspaceRepository } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ repository: sql<string>`lower(${workspaceRepository.repository})` })
      .from(workspaceRepository)
      .innerJoin(workspace, eq(workspace.id, workspaceRepository.workspaceId))
      .innerJoin(
        linearSession,
        and(
          eq(linearSession.organizationId, workspace.linearOrganizationId),
          eq(linearSession.teamId, workspaceRepository.teamId),
        ),
      )
      .where(eq(linearSession.sessionId, sessionId))
      .orderBy(sql`lower(${workspaceRepository.repository})`),
  );
  return rows.map((row) => row.repository);
}

export function* listRepositoryCandidatesSteps(
  q: Q,
  sessionId: string | null,
  configured: readonly RepositoryBinding[],
): Steps<RepositoryBinding[]> {
  const teamLinks = sessionId ? yield* listTeamRepositoriesSteps(q, sessionId) : [];
  const candidates = [
    ...configured,
    ...(yield* listRepositoryCatalogSteps(q)),
    ...teamLinks.map((name) => {
      const [owner, repo] = name.split("/");
      return { owner: owner!, repo: repo!, remoteUrl: `https://github.com/${name}.git` };
    }),
  ];
  const seen = new Set<string>();
  return candidates
    .filter((candidate) => {
      const name = `${candidate.owner}/${candidate.repo}`.toLowerCase();
      if (seen.has(name) || (teamLinks.length > 0 && !teamLinks.includes(name))) return false;
      seen.add(name);
      return true;
    })
    .map(({ owner, repo, remoteUrl }) => ({ owner, repo, remoteUrl }));
}

/**
 * Whether the team may use this repository (`owner/repo` in lower case): the team maps it, or the
 * team maps none and it is in the catalog.
 */
export function* teamRepositoryAllowedSteps(
  q: Q,
  workspaceId: string,
  teamId: string,
  repository: string,
): Steps<boolean> {
  const { repositoryCatalog, workspaceRepository } = q.t;
  const team = and(
    eq(workspaceRepository.workspaceId, workspaceId),
    eq(workspaceRepository.teamId, teamId),
  );
  const mapped = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(workspaceRepository)
      .where(and(team, sql`lower(${workspaceRepository.repository}) = ${repository}`))
      .limit(1),
  );
  if (mapped !== undefined) return true;
  const anyMapped = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(workspaceRepository)
      .where(team)
      .limit(1),
  );
  if (anyMapped !== undefined) return false;
  const cataloged = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(repositoryCatalog)
      .where(eq(repositoryCatalog.repository, repository))
      .limit(1),
  );
  return cataloged !== undefined;
}

export function teamRepositoryAllowed(
  db: Database,
  workspaceId: string,
  teamId: string,
  repository: string,
): boolean {
  return settled(
    sqliteDb(db).run((q) => teamRepositoryAllowedSteps(q, workspaceId, teamId, repository)),
  );
}
