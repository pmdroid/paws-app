import type { Database } from "bun:sqlite";
import { and, eq, inArray, isNotNull, isNull, lt, or } from "drizzle-orm";
import { orm } from "./orm";
import { run, runnerCommand, runnerFileObject } from "./schema";

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

export function recordRunnerFileObject(db: Database, row: RunnerFileObject): boolean {
  const existing = orm(db)
    .select({ digest: runnerFileObject.digest, sha256: runnerFileObject.sha256 })
    .from(runnerFileObject)
    .where(eq(runnerFileObject.key, row.key))
    .get();
  if (existing) return existing.digest === row.digest && existing.sha256 === row.sha256;
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

export function runnerCommandRuns(db: Database): { id: string; runId: string }[] {
  return orm(db)
    .select({ id: runnerCommand.id, runId: runnerCommand.runId })
    .from(runnerCommand)
    .where(
      and(isNotNull(runnerCommand.runId), inArray(runnerCommand.kind, ["run", "review", "task"])),
    )
    .all()
    .flatMap((row) => (row.runId ? [{ id: row.id, runId: row.runId }] : []));
}

export function forgetRunnerFileObject(db: Database, key: string): void {
  orm(db).delete(runnerFileObject).where(eq(runnerFileObject.key, key)).run();
}
