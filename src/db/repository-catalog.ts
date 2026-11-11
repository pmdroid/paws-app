import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { and, eq, sql } from "drizzle-orm";
import type { RepositoryBinding } from "../core";
import { sqliteDb, type Q, type Steps, type Db } from "./db";

export type CatalogEntry = {
  owner: string;
  repo: string;
  remoteUrl: string;
  defaultBranch: string;
};

export async function listRepositoryCatalog(store: Db): Promise<CatalogEntry[]> {
  return store.run((q) => listRepositoryCatalogSteps(q));
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

export function* replaceRepositoryCatalogSteps(
  q: Q,
  entries: readonly CatalogEntry[],
  now: number,
) {
  const { repositoryCatalog: c } = q.t;
  yield* q.exec(q.orm.delete(c));
  for (const entry of entries)
    yield* q.exec(
      q.orm
        .insert(c)
        .values({
          repository: `${entry.owner}/${entry.repo}`.toLowerCase(),
          owner: entry.owner,
          repo: entry.repo,
          remoteUrl: entry.remoteUrl,
          defaultBranch: entry.defaultBranch,
          refreshedAt: now,
        })
        .onConflictDoUpdate({
          target: c.repository,
          set: {
            owner: entry.owner,
            repo: entry.repo,
            remoteUrl: entry.remoteUrl,
            defaultBranch: entry.defaultBranch,
            refreshedAt: now,
          },
        }),
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
  await sqliteDb(db).transaction((q) => replaceRepositoryCatalogSteps(q, entries, now));
  return true;
}

export function teamRepositoryAllowedSql(
  workspaceSql: string,
  teamSql: string,
  repositorySql: string,
): string {
  return `(EXISTS (SELECT 1 FROM workspace_repository scope_link WHERE scope_link.workspace_id = ${workspaceSql} AND scope_link.team_id = ${teamSql} AND lower(scope_link.repository) = ${repositorySql}) OR (NOT EXISTS (SELECT 1 FROM workspace_repository scope_team WHERE scope_team.workspace_id = ${workspaceSql} AND scope_team.team_id = ${teamSql}) AND EXISTS (SELECT 1 FROM repository_catalog scope_catalog WHERE scope_catalog.repository = ${repositorySql})))`;
}

export async function listTeamRepositories(store: Db, sessionId: string): Promise<string[]> {
  return store.run((q) => listTeamRepositoriesSteps(q, sessionId));
}

export async function listRepositoryCandidates(
  store: Db,
  sessionId: string | null,
  configured: readonly RepositoryBinding[],
): Promise<RepositoryBinding[]> {
  return store.run((q) => listRepositoryCandidatesSteps(q, sessionId, configured));
}

export function* listTeamRepositoriesSteps(q: Q, sessionId: string): Steps<string[]> {
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

export async function teamRepositoryAllowed(
  store: Db,
  workspaceId: string,
  teamId: string,
  repository: string,
): Promise<boolean> {
  return store.run((q) => teamRepositoryAllowedSteps(q, workspaceId, teamId, repository));
}
