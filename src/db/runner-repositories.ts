import type { Database } from "bun:sqlite";
import { immediate } from "./tx";
import { auditWorkspaceAccess } from "./workspace";

export type RunnerRepositoryLists = { admin: string[] | null; host: string[] | null };

export function recordRunnerRepositories(
  db: Database,
  runnerId: string,
  repositories: readonly string[] | null,
  at: number,
): void {
  db.run(
    `INSERT INTO runner_repositories(runner_id,repositories,reported_at) VALUES(?,?,?)
     ON CONFLICT(runner_id) DO UPDATE SET repositories=excluded.repositories,reported_at=excluded.reported_at`,
    [runnerId, repositories === null ? null : JSON.stringify(repositories), at],
  );
}

export function setRunnerAdminRepositories(
  db: Database,
  input: {
    runnerId: string;
    workspaceId: string;
    userId: string;
    repositories: readonly string[] | null;
    now: number;
  },
): void {
  immediate(db, () => {
    const runner = db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM runner WHERE id=? AND workspace_id=? AND revoked_at IS NULL",
      )
      .get(input.runnerId, input.workspaceId);
    if (!runner) throw new Error("Runner is unavailable.");
    const chosen = input.repositories === null ? null : JSON.stringify(input.repositories);
    db.run(
      `INSERT INTO runner_repositories(runner_id,repositories,reported_at,admin_repositories)
       VALUES(?,NULL,0,?)
       ON CONFLICT(runner_id) DO UPDATE SET admin_repositories=excluded.admin_repositories`,
      [input.runnerId, chosen],
    );
    auditWorkspaceAccess(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      action: "runner.repositories",
      subject: input.runnerId,
      now: input.now,
    });
  });
}

export function runnerRepositoryLists(db: Database, runnerId: string): RunnerRepositoryLists {
  const row = db
    .query<{ host: string | null; admin: string | null }, [string]>(
      "SELECT repositories AS host,admin_repositories AS admin FROM runner_repositories WHERE runner_id=?",
    )
    .get(runnerId);
  return {
    admin: row?.admin == null ? null : (JSON.parse(row.admin) as string[]),
    host: row?.host == null ? null : (JSON.parse(row.host) as string[]),
  };
}

export function runnerAllowsRepository(
  db: Database,
  runnerId: string,
  repository: string,
): boolean {
  const wanted = repository.toLowerCase();
  const allows = (list: string[] | null) =>
    list === null || list.some((name) => name.toLowerCase() === wanted);
  const { admin, host } = runnerRepositoryLists(db, runnerId);
  return allows(admin) && allows(host);
}
