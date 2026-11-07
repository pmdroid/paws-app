import type { Database } from "bun:sqlite";
import { and, eq, gt, lte, ne, sql } from "drizzle-orm";
import { orm } from "./orm";
import { runnerReservation, runnerWork } from "./schema";

export const RUNNER_RESERVATION_MS = 120_000;

const UNASSIGNED = sql`NOT EXISTS(SELECT 1 FROM ${runnerWork} w WHERE w.run_id=${runnerReservation.runId} AND w.runner_id=${runnerReservation.runnerId})`;

export function reserveRunnerSlot(
  db: Database,
  input: { runId: string; runnerId: string; instanceId: string; now: number },
): boolean {
  const tx = orm(db);
  tx.delete(runnerReservation).where(lte(runnerReservation.expiresAt, input.now)).run();
  const taken = tx
    .insert(runnerReservation)
    .values({
      runId: input.runId,
      runnerId: input.runnerId,
      instanceId: input.instanceId,
      expiresAt: input.now + RUNNER_RESERVATION_MS,
    })
    .onConflictDoUpdate({
      target: runnerReservation.runId,
      set: { runnerId: input.runnerId, expiresAt: input.now + RUNNER_RESERVATION_MS },
      setWhere: eq(runnerReservation.instanceId, input.instanceId),
    })
    .returning({ runId: runnerReservation.runId })
    .all();
  return taken.length > 0;
}

export function releaseRunnerReservation(db: Database, runId: string, instanceId: string): void {
  orm(db)
    .delete(runnerReservation)
    .where(and(eq(runnerReservation.runId, runId), eq(runnerReservation.instanceId, instanceId)))
    .run();
}

export function runnerReservationHolder(db: Database, runId: string, now: number): string | null {
  return (
    orm(db)
      .select({ instanceId: runnerReservation.instanceId })
      .from(runnerReservation)
      .where(and(eq(runnerReservation.runId, runId), gt(runnerReservation.expiresAt, now)))
      .get()?.instanceId ?? null
  );
}

export function unassignedRunnerReservations(
  db: Database,
  now: number,
  exceptInstanceId: string,
  excludeRunId = "",
): Map<string, number> {
  return new Map(
    orm(db)
      .select({ runnerId: runnerReservation.runnerId, count: sql<number>`count(*)` })
      .from(runnerReservation)
      .where(
        and(
          gt(runnerReservation.expiresAt, now),
          ne(runnerReservation.runId, excludeRunId),
          ne(runnerReservation.instanceId, exceptInstanceId),
          UNASSIGNED,
        ),
      )
      .groupBy(runnerReservation.runnerId)
      .all()
      .map((row) => [row.runnerId, row.count]),
  );
}
