import type { Database } from "bun:sqlite";
import { and, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { orm } from "./orm";
import { run, runnerFileObject } from "./schema";

export type RunnerFileObject = {
  key: string;
  runId: string;
  commandId: string;
  kind: "input" | "artifact";
  name: string;
  digest: string;
  createdAt: number;
};

export function recordRunnerFileObject(db: Database, row: RunnerFileObject): boolean {
  const existing = orm(db)
    .select({ digest: runnerFileObject.digest })
    .from(runnerFileObject)
    .where(eq(runnerFileObject.key, row.key))
    .get();
  if (existing) return existing.digest === row.digest;
  orm(db).insert(runnerFileObject).values(row).run();
  return true;
}

export function runnerFileObjectNames(
  db: Database,
  commandId: string,
  kind: RunnerFileObject["kind"],
): string[] {
  return orm(db)
    .selectDistinct({ name: runnerFileObject.name })
    .from(runnerFileObject)
    .where(and(eq(runnerFileObject.commandId, commandId), eq(runnerFileObject.kind, kind)))
    .all()
    .map((row) => row.name);
}

export function prunableRunnerFileObjects(db: Database, before: number, limit = 500): string[] {
  return orm(db)
    .select({ key: runnerFileObject.key })
    .from(runnerFileObject)
    .leftJoin(run, eq(run.id, runnerFileObject.runId))
    .where(
      and(
        lt(runnerFileObject.createdAt, before),
        or(isNull(run.id), and(inArray(run.status, ["ended", "lost"]), lt(run.updatedAt, before))),
      ),
    )
    .limit(limit)
    .all()
    .map((row) => row.key);
}

export function forgetRunnerFileObject(db: Database, key: string): void {
  orm(db).delete(runnerFileObject).where(eq(runnerFileObject.key, key)).run();
}
