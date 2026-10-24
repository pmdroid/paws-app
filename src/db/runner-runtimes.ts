import type { Database } from "bun:sqlite";

/** A runtime as a runner last reported it in its heartbeat. */
export type RunnerRuntimeStatus = {
  tool: string;
  version: string;
  status: "installed" | "failed";
  /** Why the install failed; null when it is installed. */
  error: string | null;
  reportedAt: number;
};

/** Replace what the runner reported last; runtimes it no longer lists are gone from it. */
export function recordRunnerRuntimes(
  db: Database,
  runnerId: string,
  runtimes: readonly {
    tool: string;
    version: string;
    status: "installed" | "failed";
    error?: string;
  }[],
  reportedAt: number,
): void {
  db.run("DELETE FROM runner_runtime WHERE runner_id=?", [runnerId]);
  for (const runtime of runtimes)
    db.run(
      `INSERT INTO runner_runtime(runner_id,tool,version,status,error,reported_at) VALUES(?,?,?,?,?,?)
       ON CONFLICT(runner_id,tool,version) DO UPDATE SET status=excluded.status,
         error=excluded.error,reported_at=excluded.reported_at`,
      [
        runnerId,
        runtime.tool,
        runtime.version,
        runtime.status,
        runtime.status === "failed" ? (runtime.error ?? null) : null,
        reportedAt,
      ],
    );
}

export function listRunnerRuntimes(db: Database, runnerId: string): RunnerRuntimeStatus[] {
  return db
    .query<RunnerRuntimeStatus, [string]>(
      `SELECT tool,version,status,error,reported_at AS reportedAt FROM runner_runtime
       WHERE runner_id=? ORDER BY tool,version`,
    )
    .all(runnerId);
}
