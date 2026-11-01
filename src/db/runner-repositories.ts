import type { Database } from "bun:sqlite";

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

export function runnerAllowsRepository(
  db: Database,
  runnerId: string,
  repository: string,
): boolean {
  const row = db
    .query<{ repositories: string | null }, [string]>(
      "SELECT repositories FROM runner_repositories WHERE runner_id=?",
    )
    .get(runnerId);
  if (!row || row.repositories === null) return true;
  const wanted = repository.toLowerCase();
  return (JSON.parse(row.repositories) as string[]).some((name) => name.toLowerCase() === wanted);
}
