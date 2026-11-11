import { and, eq, exists, isNotNull, or, sql } from "drizzle-orm";
import type { Db, Q, Steps } from "./db";

export function* activeGithubConnectionsSteps(q: Q) {
  const c = q.t.workspaceGithubConnection;
  const rows = yield* q.all(
    q.orm
      .select({ secret_id: c.secretId, generation: c.generation })
      .from(c)
      .where(and(isNotNull(c.secretId), isNotNull(c.installationId))),
  );
  return rows.map((row) => ({ secret_id: row.secret_id!, generation: row.generation }));
}

export function activeGithubConnections(
  db: Db,
): Promise<{ secret_id: string; generation: number }[]> {
  return db.run((q) => activeGithubConnectionsSteps(q));
}

export function* anyWorkspaceSteps(q: Q): Steps<boolean> {
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(q.t.workspace)
      .limit(1),
  );
  return row !== undefined;
}

export function anyWorkspace(db: Db): Promise<boolean> {
  return db.run((q) => anyWorkspaceSteps(q));
}

export function* repositoryCataloguedSteps(q: Q, repository: string): Steps<boolean> {
  const k = q.t.repositoryCatalog;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(k)
      .where(eq(k.repository, repository.toLowerCase())),
  );
  return row !== undefined;
}

export function repositoryCatalogued(db: Db, repository: string): Promise<boolean> {
  return db.run((q) => repositoryCataloguedSteps(q, repository));
}

export function* repositoryGithubConnectionsSteps(q: Q, repository: string) {
  const { workspaceGithubConnection: c, workspaceRepository: r, repositoryCatalog: k } = q.t;
  const name = repository.toLowerCase();
  return yield* q.all(
    q.orm
      .selectDistinct({
        secret_id: c.secretId,
        generation: c.generation,
        repositories: c.repositories,
      })
      .from(c)
      .where(
        or(
          exists(
            q.orm
              .select({ one: sql`1` })
              .from(r)
              .where(and(eq(r.workspaceId, c.workspaceId), sql`lower(${r.repository}) = ${name}`)),
          ),
          exists(
            q.orm
              .select({ one: sql`1` })
              .from(k)
              .where(eq(k.repository, name)),
          ),
        ),
      ),
  );
}

export function repositoryGithubConnections(
  db: Db,
  repository: string,
): Promise<{ secret_id: string | null; generation: number; repositories: string }[]> {
  return db.run((q) => repositoryGithubConnectionsSteps(q, repository));
}
