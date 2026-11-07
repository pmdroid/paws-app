import type { Database } from "bun:sqlite";
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import {
  creditedLeaseUntil,
  OFFLINE_LEASE_RUNNER_VERSION,
  PAWS_ALIVE_LEASE_SKEW_MS,
  RUNNER_LEASE_GRACE_MS,
  RUNNER_OFFLINE_BUDGET_MS,
  runnerReleaseAtLeast,
} from "../runner-protocol";
import { ownerGone } from "./instances";
import { settled, sqliteDb, type Q } from "./db";
import { orm } from "./orm";
import {
  instance,
  runner,
  runnerCommand,
  runnerHostStatus,
  runnerResult,
  runnerWork,
  runOwner,
} from "./schema";

export { PAWS_ALIVE_LEASE_SKEW_MS };

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
  settled(sqliteDb(db).run((q) => endRevokedRunnerAuthoritySteps(q, now)));
}

export function* endRevokedRunnerAuthoritySteps(q: Q, now: number) {
  const { runner: runners, runnerWork: work } = q.t;
  const cutoff = runnerLeaseCutoff(now);
  yield* q.exec(
    q.orm
      .update(work)
      .set({ leaseUntil: cutoff })
      .where(
        and(
          isNull(work.endedAt),
          gt(work.leaseUntil, cutoff),
          inArray(
            work.runnerId,
            q.orm
              .select({ id: runners.id })
              .from(runners)
              .where(or(isNotNull(runners.revokedAt), eq(runners.status, "revoked"))),
          ),
        ),
      ),
  );
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

type InstanceSpan = { id: string; startedAt: number; heartbeatAt: number };

/**
 * How long no instance served the runs `owner` held. It starts where instances alive without a
 * break since the owner's last heartbeat stopped, and adds up every stretch until `now` when no
 * instance was alive. `until` is `aliveAt` plus that time. `self` is alive at `now`. Null when
 * instances were alive throughout.
 */
function ownerDowntime(
  spans: readonly InstanceSpan[],
  owner: string,
  self: string | undefined,
  now: number,
): { aliveAt: number; until: number } | null {
  let aliveAt = spans.find((span) => span.id === owner)?.heartbeatAt;
  if (aliveAt === undefined) return null;
  const others = spans
    .filter((span) => span.id !== owner)
    .map((span) => (span.id === self ? { ...span, heartbeatAt: now } : span));
  for (let extended = true; extended;) {
    extended = false;
    for (const span of others)
      if (span.startedAt <= aliveAt && span.heartbeatAt > aliveAt) {
        aliveAt = span.heartbeatAt;
        extended = true;
      }
  }
  let uncovered = 0;
  let coveredTo = aliveAt;
  const later = others
    .filter((span) => span.startedAt > aliveAt && span.startedAt < now)
    .sort((a, b) => a.startedAt - b.startedAt);
  for (const span of later) {
    uncovered += Math.max(0, span.startedAt - coveredTo);
    coveredTo = Math.max(coveredTo, Math.min(span.heartbeatAt, now));
  }
  uncovered += Math.max(0, now - coveredTo);
  return uncovered > 0 ? { aliveAt, until: aliveAt + uncovered } : null;
}

/**
 * When `self` takes over the runs of gone instances, move the lease of their open runner work
 * forward by the time no instance was alive, so that downtime does not count against it. The
 * downtime is the time no instance was alive between the owning instance's last heartbeat, or
 * the end of instances alive since without a break, and the takeover; it is none when another
 * instance was alive throughout. Work without an owner counts the newest other instance
 * as its owner. The new deadline is `creditedLeaseUntil`, capped by `budgetMs` and by each
 * command's `expiresAt`. Work the runner gave up on stays given up: a row with a result, an
 * acknowledged cancel, or a lease already past the grace when its owner was last alive is not
 * extended. A runner older than `OFFLINE_LEASE_RUNNER_VERSION` still stops at its own grace, so
 * its lease is not moved. Run inside the transaction that takes the runs over.
 */
export function shiftRunnerLeasesForDowntime(
  db: Database,
  now: number,
  budgetMs = RUNNER_OFFLINE_BUDGET_MS,
  self?: string,
): void {
  const eligible = new Set(
    orm(db)
      .select({ id: runner.id, version: runnerHostStatus.runnerVersion })
      .from(runner)
      .leftJoin(runnerHostStatus, eq(runnerHostStatus.runnerId, runner.id))
      .where(and(isNull(runner.revokedAt), ne(runner.status, "revoked")))
      .all()
      .filter((host) => runnerReleaseAtLeast(host.version, OFFLINE_LEASE_RUNNER_VERSION))
      .map((host) => host.id),
  );
  if (eligible.size === 0) return;
  const rows = orm(db)
    .select({
      runId: runnerWork.runId,
      runnerId: runnerWork.runnerId,
      leaseUntil: runnerWork.leaseUntil,
      expiresAt: runnerCommand.expiresAt,
      owner: runOwner.ownerInstance,
    })
    .from(runnerWork)
    .innerJoin(runnerCommand, eq(runnerCommand.id, runnerWork.commandId))
    .leftJoin(runOwner, eq(runOwner.runId, runnerWork.runId))
    .where(and(isNull(runnerWork.endedAt), unsettledRunnerWork(db)))
    .all()
    .filter((row) => eligible.has(row.runnerId));
  if (rows.length === 0) return;
  const spans: InstanceSpan[] = orm(db)
    .select({ id: instance.id, startedAt: instance.startedAt, heartbeatAt: instance.heartbeatAt })
    .from(instance)
    .all();
  const gone = self === undefined ? () => true : ownerGone(db, self, now);
  const newest = spans
    .filter((span) => span.id !== self)
    .reduce<InstanceSpan | null>((a, b) => (a && a.heartbeatAt >= b.heartbeatAt ? a : b), null);
  for (const row of rows) {
    const owner = row.owner ?? newest?.id;
    if (owner === undefined || !gone(owner)) continue;
    const down = ownerDowntime(spans, owner, self, now);
    if (down === null) continue;
    const leaseUntil = creditedLeaseUntil({
      leaseUntil: row.leaseUntil,
      expiresAt: row.expiresAt,
      aliveAt: down.aliveAt,
      now: down.until,
      budgetMs,
      skewMs: PAWS_ALIVE_LEASE_SKEW_MS,
    });
    if (leaseUntil !== row.leaseUntil)
      orm(db).update(runnerWork).set({ leaseUntil }).where(eq(runnerWork.runId, row.runId)).run();
  }
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
