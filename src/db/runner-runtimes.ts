import { and, asc, eq } from "drizzle-orm";
import { type Q, type Db } from "./db";

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
  const key = (tool: string, version: string) => JSON.stringify([tool, version]);
  const stored = new Map(
    (yield* q.all(
      q.orm
        .select({
          tool: runnerRuntime.tool,
          version: runnerRuntime.version,
          status: runnerRuntime.status,
          error: runnerRuntime.error,
        })
        .from(runnerRuntime)
        .where(eq(runnerRuntime.runnerId, runnerId)),
    )).map((row) => [key(row.tool, row.version), row]),
  );
  const reported = new Map(
    runtimes.map((runtime) => [
      key(runtime.tool, runtime.version),
      {
        tool: runtime.tool,
        version: runtime.version,
        status: runtime.status,
        error: runtime.status === "failed" ? (runtime.error ?? null) : null,
      },
    ]),
  );
  for (const [id, row] of stored)
    if (!reported.has(id))
      yield* q.exec(
        q.orm
          .delete(runnerRuntime)
          .where(
            and(
              eq(runnerRuntime.runnerId, runnerId),
              eq(runnerRuntime.tool, row.tool),
              eq(runnerRuntime.version, row.version),
            ),
          ),
      );
  for (const [id, values] of reported) {
    const before = stored.get(id);
    if (!before)
      yield* q.exec(q.orm.insert(runnerRuntime).values({ runnerId, ...values, reportedAt }));
    else if (!Bun.deepEquals(before, values))
      yield* q.exec(
        q.orm
          .update(runnerRuntime)
          .set({ status: values.status, error: values.error, reportedAt })
          .where(
            and(
              eq(runnerRuntime.runnerId, runnerId),
              eq(runnerRuntime.tool, values.tool),
              eq(runnerRuntime.version, values.version),
            ),
          ),
      );
  }
}

/** Replace what the runner reported last; runtimes it no longer lists are gone from it. */
export async function recordRunnerRuntimes(
  store: Db,
  runnerId: string,
  runtimes: readonly ReportedRuntime[],
  reportedAt: number,
): Promise<void> {
  await store.run((q) => recordRunnerRuntimesSteps(q, runnerId, runtimes, reportedAt));
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

export async function listRunnerRuntimes(
  store: Db,
  runnerId: string,
): Promise<RunnerRuntimeStatus[]> {
  return store.run((q) => listRunnerRuntimesSteps(q, runnerId));
}
