import { and, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { type Q, type Db } from "./db";

export type RunnerFileObject = {
  key: string;
  runId: string;
  commandId: string;
  kind: "input" | "artifact";
  name: string;
  digest: string;
  sha256: string;
  createdAt: number;
};

export function* recordRunnerFileObjectSteps(q: Q, row: RunnerFileObject) {
  const { runnerFileObject } = q.t;
  const existing = yield* q.one(
    q.orm
      .select({ digest: runnerFileObject.digest, sha256: runnerFileObject.sha256 })
      .from(runnerFileObject)
      .where(eq(runnerFileObject.key, row.key)),
  );
  if (existing) return existing.digest === row.digest && existing.sha256 === row.sha256;
  yield* q.exec(q.orm.insert(runnerFileObject).values(row));
  return true;
}

export async function recordRunnerFileObject(store: Db, row: RunnerFileObject): Promise<boolean> {
  return store.run((q) => recordRunnerFileObjectSteps(q, row));
}

export function* runnerFileObjectNamesSteps(
  q: Q,
  commandId: string,
  kind: RunnerFileObject["kind"],
) {
  const { runnerFileObject } = q.t;
  const rows = yield* q.all(
    q.orm
      .selectDistinct({ name: runnerFileObject.name })
      .from(runnerFileObject)
      .where(and(eq(runnerFileObject.commandId, commandId), eq(runnerFileObject.kind, kind))),
  );
  return rows.map((row) => row.name);
}

export async function runnerFileObjectNames(
  store: Db,
  commandId: string,
  kind: RunnerFileObject["kind"],
): Promise<string[]> {
  return store.run((q) => runnerFileObjectNamesSteps(q, commandId, kind));
}

export function* prunableRunnerFileObjectsSteps(q: Q, before: number, limit = 500) {
  const { run, runnerFileObject } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ key: runnerFileObject.key })
      .from(runnerFileObject)
      .leftJoin(run, eq(run.id, runnerFileObject.runId))
      .where(
        and(
          lt(runnerFileObject.createdAt, before),
          or(
            isNull(run.id),
            and(inArray(run.status, ["ended", "lost"]), lt(run.updatedAt, before)),
          ),
        ),
      )
      .limit(limit),
  );
  return rows.map((row) => row.key);
}

export async function prunableRunnerFileObjects(
  store: Db,
  before: number,
  limit = 500,
): Promise<string[]> {
  return store.run((q) => prunableRunnerFileObjectsSteps(q, before, limit));
}

export function* runnerCommandRunsSteps(q: Q) {
  const { runnerCommand } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ id: runnerCommand.id, runId: runnerCommand.runId })
      .from(runnerCommand)
      .where(
        and(isNotNull(runnerCommand.runId), inArray(runnerCommand.kind, ["run", "review", "task"])),
      ),
  );
  return rows.flatMap((row) => (row.runId ? [{ id: row.id, runId: row.runId }] : []));
}

export async function runnerCommandRuns(store: Db): Promise<{ id: string; runId: string }[]> {
  return store.run((q) => runnerCommandRunsSteps(q));
}

export function* forgetRunnerFileObjectSteps(q: Q, key: string) {
  yield* q.exec(q.orm.delete(q.t.runnerFileObject).where(eq(q.t.runnerFileObject.key, key)));
}

export async function forgetRunnerFileObject(store: Db, key: string): Promise<void> {
  await store.run((q) => forgetRunnerFileObjectSteps(q, key));
}
