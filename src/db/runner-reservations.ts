import { and, eq, gt, lte, ne, sql } from "drizzle-orm";
import type { Db, Q } from "./db";

export const RUNNER_RESERVATION_MS = 120_000;

type Reservation = { runId: string; runnerId: string; instanceId: string; now: number };

export function* reserveRunnerSlotSteps(q: Q, input: Reservation) {
  const { runnerReservation } = q.t;
  const row = {
    runId: input.runId,
    runnerId: input.runnerId,
    instanceId: input.instanceId,
    expiresAt: input.now + RUNNER_RESERVATION_MS,
  };
  yield* q.exec(q.orm.delete(runnerReservation).where(lte(runnerReservation.expiresAt, input.now)));
  const taken = yield* q.all(
    q.orm
      .insert(runnerReservation)
      .values(row)
      .onConflictDoUpdate({
        target: runnerReservation.runId,
        set: { runnerId: row.runnerId, expiresAt: row.expiresAt },
        setWhere: eq(runnerReservation.instanceId, input.instanceId),
      })
      .returning({ runId: runnerReservation.runId }),
  );
  return taken.length > 0;
}

export function reserveRunnerSlot(db: Db, input: Reservation): Promise<boolean> {
  return db.transaction((q) => reserveRunnerSlotSteps(q, input));
}

export function* releaseRunnerReservationSteps(q: Q, runId: string, instanceId: string) {
  const { runnerReservation } = q.t;
  yield* q.exec(
    q.orm
      .delete(runnerReservation)
      .where(and(eq(runnerReservation.runId, runId), eq(runnerReservation.instanceId, instanceId))),
  );
}

export function releaseRunnerReservation(db: Db, runId: string, instanceId: string): Promise<void> {
  return db.run((q) => releaseRunnerReservationSteps(q, runId, instanceId));
}

export function* runnerReservationHolderSteps(q: Q, runId: string, now: number) {
  const { runnerReservation } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ instanceId: runnerReservation.instanceId })
      .from(runnerReservation)
      .where(and(eq(runnerReservation.runId, runId), gt(runnerReservation.expiresAt, now))),
  );
  return row?.instanceId ?? null;
}

export function runnerReservationHolder(
  db: Db,
  runId: string,
  now: number,
): Promise<string | null> {
  return db.run((q) => runnerReservationHolderSteps(q, runId, now));
}

export function* unassignedRunnerReservationsSteps(
  q: Q,
  now: number,
  exceptInstanceId: string,
  excludeRunId = "",
) {
  const { runnerReservation } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        runnerId: runnerReservation.runnerId,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(runnerReservation)
      .where(
        and(
          gt(runnerReservation.expiresAt, now),
          ne(runnerReservation.runId, excludeRunId),
          ne(runnerReservation.instanceId, exceptInstanceId),
          sql`NOT EXISTS(SELECT 1 FROM runner_work w WHERE w.run_id=runner_reservation.run_id
            AND w.runner_id=runner_reservation.runner_id)`,
        ),
      )
      .groupBy(runnerReservation.runnerId),
  );
  return new Map(rows.map((row) => [row.runnerId, row.count]));
}

export function unassignedRunnerReservations(
  db: Db,
  now: number,
  exceptInstanceId: string,
  excludeRunId = "",
): Promise<Map<string, number>> {
  return db.run((q) => unassignedRunnerReservationsSteps(q, now, exceptInstanceId, excludeRunId));
}
