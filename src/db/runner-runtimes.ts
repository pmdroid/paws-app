import type { Database } from "bun:sqlite";
import { asc, eq } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

/** A runtime as a runner last reported it in its heartbeat. */
export type RunnerRuntimeStatus = {
  tool: string;
  version: string;
  status: "installed" | "failed";
  /** Why the install failed; null when it is installed. */
  error: string | null;
  reportedAt: number;
};

type ReportedRuntime = {
  tool: string;
  version: string;
  status: "installed" | "failed";
  error?: string;
};

export function* recordRunnerRuntimesSteps(
  q: Q,
  runnerId: string,
  runtimes: readonly ReportedRuntime[],
  reportedAt: number,
) {
  const { runnerRuntime } = q.t;
  yield* q.exec(q.orm.delete(runnerRuntime).where(eq(runnerRuntime.runnerId, runnerId)));
  for (const runtime of runtimes) {
    const values = {
      status: runtime.status,
      error: runtime.status === "failed" ? (runtime.error ?? null) : null,
      reportedAt,
    };
    yield* q.exec(
      q.orm
        .insert(runnerRuntime)
        .values({ runnerId, tool: runtime.tool, version: runtime.version, ...values })
        .onConflictDoUpdate({
          target: [runnerRuntime.runnerId, runnerRuntime.tool, runnerRuntime.version],
          set: values,
        }),
    );
  }
}

/** Replace what the runner reported last; runtimes it no longer lists are gone from it. */
export function recordRunnerRuntimes(
  db: Database,
  runnerId: string,
  runtimes: readonly ReportedRuntime[],
  reportedAt: number,
): void {
  settled(sqliteDb(db).run((q) => recordRunnerRuntimesSteps(q, runnerId, runtimes, reportedAt)));
}

export function* listRunnerRuntimesSteps(q: Q, runnerId: string) {
  const { runnerRuntime } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        tool: runnerRuntime.tool,
        version: runnerRuntime.version,
        status: runnerRuntime.status,
        error: runnerRuntime.error,
        reportedAt: runnerRuntime.reportedAt,
      })
      .from(runnerRuntime)
      .where(eq(runnerRuntime.runnerId, runnerId))
      .orderBy(asc(runnerRuntime.tool), asc(runnerRuntime.version)),
  );
  return rows as RunnerRuntimeStatus[];
}

export function listRunnerRuntimes(db: Database, runnerId: string): RunnerRuntimeStatus[] {
  return settled(sqliteDb(db).run((q) => listRunnerRuntimesSteps(q, runnerId)));
}
