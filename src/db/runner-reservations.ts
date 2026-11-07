import { and, eq, gt, lte, ne, sql } from "drizzle-orm";
import type { Db } from "./db";
import { runnerReservation, runnerWork } from "./schema";
import * as pg from "./schema-pg";

export const RUNNER_RESERVATION_MS = 120_000;

const UNASSIGNED = sql`NOT EXISTS(SELECT 1 FROM ${runnerWork} w WHERE w.run_id=${runnerReservation.runId} AND w.runner_id=${runnerReservation.runnerId})`;
const PG_UNASSIGNED = sql`NOT EXISTS(SELECT 1 FROM ${pg.runnerWork} w WHERE w.run_id=${pg.runnerReservation.runId} AND w.runner_id=${pg.runnerReservation.runnerId})`;

export function reserveRunnerSlot(
  db: Db,
  input: { runId: string; runnerId: string; instanceId: string; now: number },
): Promise<boolean> {
  const row = {
    runId: input.runId,
    runnerId: input.runnerId,
    instanceId: input.instanceId,
    expiresAt: input.now + RUNNER_RESERVATION_MS,
  };
  if (db.dialect === "sqlite")
    return db.sync((handle) => {
      handle.delete(runnerReservation).where(lte(runnerReservation.expiresAt, input.now)).run();
      return (
        handle
          .insert(runnerReservation)
          .values(row)
          .onConflictDoUpdate({
            target: runnerReservation.runId,
            set: { runnerId: row.runnerId, expiresAt: row.expiresAt },
            setWhere: eq(runnerReservation.instanceId, input.instanceId),
          })
          .returning({ runId: runnerReservation.runId })
          .all().length > 0
      );
    });
  return db.orm.transaction(async (tx) => {
    await tx.delete(pg.runnerReservation).where(lte(pg.runnerReservation.expiresAt, input.now));
    const taken = await tx
      .insert(pg.runnerReservation)
      .values(row)
      .onConflictDoUpdate({
        target: pg.runnerReservation.runId,
        set: { runnerId: row.runnerId, expiresAt: row.expiresAt },
        setWhere: eq(pg.runnerReservation.instanceId, input.instanceId),
      })
      .returning({ runId: pg.runnerReservation.runId });
    return taken.length > 0;
  });
}

export function releaseRunnerReservation(db: Db, runId: string, instanceId: string): Promise<void> {
  if (db.dialect === "sqlite")
    return db.sync((handle) => {
      handle
        .delete(runnerReservation)
        .where(
          and(eq(runnerReservation.runId, runId), eq(runnerReservation.instanceId, instanceId)),
        )
        .run();
    });
  return db.orm
    .delete(pg.runnerReservation)
    .where(
      and(eq(pg.runnerReservation.runId, runId), eq(pg.runnerReservation.instanceId, instanceId)),
    )
    .then(() => undefined);
}

export function runnerReservationHolder(
  db: Db,
  runId: string,
  now: number,
): Promise<string | null> {
  if (db.dialect === "sqlite")
    return db.sync(
      (handle) =>
        handle
          .select({ instanceId: runnerReservation.instanceId })
          .from(runnerReservation)
          .where(and(eq(runnerReservation.runId, runId), gt(runnerReservation.expiresAt, now)))
          .get()?.instanceId ?? null,
    );
  return db.orm
    .select({ instanceId: pg.runnerReservation.instanceId })
    .from(pg.runnerReservation)
    .where(and(eq(pg.runnerReservation.runId, runId), gt(pg.runnerReservation.expiresAt, now)))
    .then((rows) => rows[0]?.instanceId ?? null);
}

export function unassignedRunnerReservations(
  db: Db,
  now: number,
  exceptInstanceId: string,
  excludeRunId = "",
): Promise<Map<string, number>> {
  if (db.dialect === "sqlite")
    return db.sync(
      (handle) =>
        new Map(
          handle
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
        ),
    );
  return db.orm
    .select({
      runnerId: pg.runnerReservation.runnerId,
      count: sql<number>`count(*)::int`,
    })
    .from(pg.runnerReservation)
    .where(
      and(
        gt(pg.runnerReservation.expiresAt, now),
        ne(pg.runnerReservation.runId, excludeRunId),
        ne(pg.runnerReservation.instanceId, exceptInstanceId),
        PG_UNASSIGNED,
      ),
    )
    .groupBy(pg.runnerReservation.runnerId)
    .then((rows) => new Map(rows.map((row) => [row.runnerId, row.count])));
}
