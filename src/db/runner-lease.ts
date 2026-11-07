import type { Database } from "bun:sqlite";
import { and, eq, exists, gt, isNotNull, isNull, ne, notExists, or, sql } from "drizzle-orm";
import {
  creditedLeaseUntil,
  OFFLINE_LEASE_RUNNER_VERSION,
  PAWS_ALIVE_INTERVAL_MS,
  PAWS_ALIVE_LEASE_SKEW_MS,
  RUNNER_LEASE_GRACE_MS,
  RUNNER_OFFLINE_BUDGET_MS,
  runnerReleaseAtLeast,
} from "../runner-protocol";
import { orm } from "./orm";
import {
  pawsAlive,
  runner,
  runnerCommand,
  runnerHostStatus,
  runnerResult,
  runnerWork,
} from "./schema";

export { PAWS_ALIVE_INTERVAL_MS, PAWS_ALIVE_LEASE_SKEW_MS };

/**
 * The runner keeps working until `lease_until + RUNNER_LEASE_GRACE_MS`, so Paws treats a lease as
 * live until then too. Bind the returned value where a query reads `lease_until > ?`. Using `now`
 * there instead fences a healthy run whenever Paws is away longer than one renewal.
 */
export function runnerLeaseCutoff(now: number): number {
  return now - RUNNER_LEASE_GRACE_MS;
}

/** Whether a `runner_work.lease_until` value is still live at `now`, grace included. */
export function runnerLeaseLive(leaseUntil: number, now: number): boolean {
  return leaseUntil > runnerLeaseCutoff(now);
}

export function endRevokedRunnerAuthority(db: Database, now: number): void {
  const cutoff = runnerLeaseCutoff(now);
  const q = orm(db);
  q.update(runnerWork)
    .set({ leaseUntil: cutoff })
    .where(
      and(
        isNull(runnerWork.endedAt),
        gt(runnerWork.leaseUntil, cutoff),
        sql`${runnerWork.runnerId} IN ${q
          .select({ id: runner.id })
          .from(runner)
          .where(or(isNotNull(runner.revokedAt), eq(runner.status, "revoked")))}`,
      ),
    )
    .run();
}

/** The result of the work's current command. Queries select from runner_work. */
function currentResult(db: Database) {
  return orm(db)
    .select({ one: sql`1` })
    .from(runnerResult)
    .where(
      and(
        eq(runnerResult.runId, runnerWork.runId),
        eq(runnerResult.generation, runnerWork.generation),
        eq(runnerResult.commandId, runnerWork.commandId),
      ),
    );
}

/** Settled results and acknowledged cancellations no longer hold work. */
function unsettledRunnerWork(db: Database) {
  return and(
    notExists(currentResult(db)),
    notExists(
      orm(db)
        .select({ one: sql`1` })
        .from(runnerCommand)
        .where(
          and(
            eq(runnerCommand.runId, runnerWork.runId),
            eq(runnerCommand.generation, runnerWork.generation),
            eq(runnerCommand.runnerId, runnerWork.runnerId),
            eq(runnerCommand.kind, "cancel"),
            isNotNull(runnerCommand.acknowledgedAt),
          ),
        ),
    ),
  );
}

/**
 * Whether Paws may release the runner slot of `runId` without fencing work the runner still does.
 * True when no work is open, when the lease is past the grace, when the runner sent its result
 * for the current command, or when the runner acknowledged a cancel Paws sent for it. The halt
 * core (restart, stop, take-over) waits for this before it releases a runner it did not ask to stop.
 */
export function runnerWorkSettled(db: Database, runId: string, now: number): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(runnerWork)
      .where(
        and(
          eq(runnerWork.runId, runId),
          isNull(runnerWork.endedAt),
          gt(runnerWork.leaseUntil, runnerLeaseCutoff(now)),
          unsettledRunnerWork(db),
        ),
      )
      .get() === undefined
  );
}

/** Record that Paws is alive at `now`. Startup reads it to tell how long Paws was down. */
export function markPawsAlive(db: Database, now: number): void {
  orm(db)
    .insert(pawsAlive)
    .values({ id: 1, at: now })
    .onConflictDoUpdate({ target: pawsAlive.id, set: { at: now } })
    .run();
}

/** When Paws last recorded that it was alive, or null when it never has. */
export function pawsAliveAt(db: Database): number | null {
  return (
    orm(db).select({ at: pawsAlive.at }).from(pawsAlive).where(eq(pawsAlive.id, 1)).get()?.at ??
    null
  );
}

/**
 * On start, move the lease of open runner work forward by the time Paws was down, so downtime
 * does not count against it. The new deadline is `creditedLeaseUntil`, capped by `budgetMs` and
 * by each command's `expiresAt`. Work the runner gave up on stays given up: a row with a result,
 * an acknowledged cancel, or a lease already past the grace when Paws was last alive is not
 * extended. A runner older than `OFFLINE_LEASE_RUNNER_VERSION` still stops at its own grace, so
 * its lease is not moved. Returns how long Paws was down, capped by the budget. Run inside the
 * startup transaction; it records Paws alive at `now`.
 */
export function shiftRunnerLeasesForDowntime(
  db: Database,
  now: number,
  budgetMs = RUNNER_OFFLINE_BUDGET_MS,
): number {
  const aliveAt = pawsAliveAt(db);
  markPawsAlive(db, now);
  if (aliveAt === null) return 0;
  const shift = Math.min(Math.max(0, now - aliveAt), Math.max(0, budgetMs));
  if (shift === 0) return 0;
  const eligible = new Set(
    orm(db)
      .select({ id: runner.id, version: runnerHostStatus.runnerVersion })
      .from(runner)
      .leftJoin(runnerHostStatus, eq(runnerHostStatus.runnerId, runner.id))
      .where(and(isNull(runner.revokedAt), ne(runner.status, "revoked")))
      .all()
      .filter((runner) => runnerReleaseAtLeast(runner.version, OFFLINE_LEASE_RUNNER_VERSION))
      .map((runner) => runner.id),
  );
  if (eligible.size === 0) return 0;
  const rows = orm(db)
    .select({
      runId: runnerWork.runId,
      runnerId: runnerWork.runnerId,
      leaseUntil: runnerWork.leaseUntil,
      expiresAt: runnerCommand.expiresAt,
    })
    .from(runnerWork)
    .innerJoin(runnerCommand, eq(runnerCommand.id, runnerWork.commandId))
    .where(and(isNull(runnerWork.endedAt), unsettledRunnerWork(db)))
    .all();
  for (const row of rows) {
    if (!eligible.has(row.runnerId)) continue;
    const leaseUntil = creditedLeaseUntil({
      leaseUntil: row.leaseUntil,
      expiresAt: row.expiresAt,
      aliveAt,
      now,
      budgetMs,
      skewMs: PAWS_ALIVE_LEASE_SKEW_MS,
    });
    if (leaseUntil !== row.leaseUntil)
      orm(db).update(runnerWork).set({ leaseUntil }).where(eq(runnerWork.runId, row.runId)).run();
  }
  return shift;
}

/** Open work still belongs to its run while leased or while a delivered result awaits import. */
export function runnerHoldsRunWork(
  db: Database,
  runId: string,
  now: number,
  cancelled = false,
): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(runnerWork)
      .where(
        and(
          eq(runnerWork.runId, runId),
          isNull(runnerWork.endedAt),
          or(
            gt(runnerWork.leaseUntil, runnerLeaseCutoff(now)),
            cancelled ? undefined : exists(currentResult(db)),
          ),
        ),
      )
      .get() !== undefined
  );
}

/** The current command delivered a result that its owning run has not imported yet. */
export function runnerWorkHasResult(db: Database, runId: string): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(runnerWork)
      .where(
        and(eq(runnerWork.runId, runId), isNull(runnerWork.endedAt), exists(currentResult(db))),
      )
      .get() !== undefined
  );
}
