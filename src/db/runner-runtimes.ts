import type { Database } from "bun:sqlite";
import { asc, eq, sql } from "drizzle-orm";
import { orm } from "./orm";
import { runnerRuntime } from "./schema";

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
  orm(db).delete(runnerRuntime).where(eq(runnerRuntime.runnerId, runnerId)).run();
  for (const runtime of runtimes) {
    const values = {
      status: runtime.status,
      error: runtime.status === "failed" ? (runtime.error ?? null) : null,
      reportedAt,
    };
    orm(db)
      .insert(runnerRuntime)
      .values({ runnerId, tool: runtime.tool, version: runtime.version, ...values })
      .onConflictDoUpdate({
        target: [runnerRuntime.runnerId, runnerRuntime.tool, runnerRuntime.version],
        set: values,
      })
      .run();
  }
}

export function listRunnerRuntimes(db: Database, runnerId: string): RunnerRuntimeStatus[] {
  return orm(db)
    .select({
      tool: runnerRuntime.tool,
      version: runnerRuntime.version,
      status: sql<RunnerRuntimeStatus["status"]>`${runnerRuntime.status}`,
      error: runnerRuntime.error,
      reportedAt: runnerRuntime.reportedAt,
    })
    .from(runnerRuntime)
    .where(eq(runnerRuntime.runnerId, runnerId))
    .orderBy(asc(runnerRuntime.tool), asc(runnerRuntime.version))
    .all();
}
