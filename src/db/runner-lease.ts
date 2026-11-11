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
import { type Q, type Db } from "./db";
import { ownerGoneSteps } from "./instances";

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

export function* endRevokedRunnerAuthoritySteps(q: Q, now: number) {
  const { runner, runnerWork } = q.t;
  const cutoff = runnerLeaseCutoff(now);
  yield* q.exec(
    q.orm
      .update(runnerWork)
      .set({ leaseUntil: cutoff })
      .where(
        and(
          isNull(runnerWork.endedAt),
          gt(runnerWork.leaseUntil, cutoff),
          inArray(
            runnerWork.runnerId,
            q.orm
              .select({ id: runner.id })
              .from(runner)
              .where(or(isNotNull(runner.revokedAt), eq(runner.status, "revoked"))),
          ),
        ),
      ),
  );
}

export async function endRevokedRunnerAuthority(store: Db, now: number): Promise<void> {
  await store.run((q) => endRevokedRunnerAuthoritySteps(q, now));
}

/** The result of the work's current command. Queries select from runner_work. */
function currentResult(q: Q) {
  const { runnerResult, runnerWork } = q.t;
  return q.orm
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
function unsettledRunnerWork(q: Q) {
  const { runnerCommand, runnerWork } = q.t;
  return and(
    notExists(currentResult(q)),
    notExists(
      q.orm
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

export function* runnerWorkSettledSteps(q: Q, runId: string, now: number) {
  const { runnerWork } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(runnerWork)
      .where(
        and(
          eq(runnerWork.runId, runId),
          isNull(runnerWork.endedAt),
          gt(runnerWork.leaseUntil, runnerLeaseCutoff(now)),
          unsettledRunnerWork(q),
        ),
      ),
  );
  return row === undefined;
}

/**
 * Whether Paws may release the runner slot of `runId` without fencing work the runner still does.
 * True when no work is open, when the lease is past the grace, when the runner sent its result
 * for the current command, or when the runner acknowledged a cancel Paws sent for it. The halt
 * core (restart, stop, take-over) waits for this before it releases a runner it did not ask to stop.
 */
export async function runnerWorkSettled(store: Db, runId: string, now: number): Promise<boolean> {
  return store.run((q) => runnerWorkSettledSteps(q, runId, now));
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

export function* shiftRunnerLeasesForDowntimeSteps(
  q: Q,
  now: number,
  budgetMs = RUNNER_OFFLINE_BUDGET_MS,
  self?: string,
) {
  const { instance, runner, runnerCommand, runnerHostStatus, runnerWork, runOwner } = q.t;
  const hosts = yield* q.all(
    q.orm
      .select({ id: runner.id, version: runnerHostStatus.runnerVersion })
      .from(runner)
      .leftJoin(runnerHostStatus, eq(runnerHostStatus.runnerId, runner.id))
      .where(and(isNull(runner.revokedAt), ne(runner.status, "revoked"))),
  );
  const eligible = new Set(
    hosts
      .filter((host) => runnerReleaseAtLeast(host.version, OFFLINE_LEASE_RUNNER_VERSION))
      .map((host) => host.id),
  );
  if (eligible.size === 0) return;
  const open = yield* q.all(
    q.orm
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
      .where(and(isNull(runnerWork.endedAt), unsettledRunnerWork(q))),
  );
  const rows = open.filter((row) => eligible.has(row.runnerId));
  if (rows.length === 0) return;
  const spans: InstanceSpan[] = yield* q.all(
    q.orm
      .select({ id: instance.id, startedAt: instance.startedAt, heartbeatAt: instance.heartbeatAt })
      .from(instance),
  );
  const gone = self === undefined ? () => true : yield* ownerGoneSteps(q, self, now);
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
      yield* q.exec(
        q.orm.update(runnerWork).set({ leaseUntil }).where(eq(runnerWork.runId, row.runId)),
      );
  }
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
export async function shiftRunnerLeasesForDowntime(
  store: Db,
  now: number,
  budgetMs = RUNNER_OFFLINE_BUDGET_MS,
  self?: string,
): Promise<void> {
  await store.run((q) => shiftRunnerLeasesForDowntimeSteps(q, now, budgetMs, self));
}

export function* runnerHoldsRunWorkSteps(q: Q, runId: string, now: number, cancelled = false) {
  const { runnerWork } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(runnerWork)
      .where(
        and(
          eq(runnerWork.runId, runId),
          isNull(runnerWork.endedAt),
          or(
            gt(runnerWork.leaseUntil, runnerLeaseCutoff(now)),
            cancelled ? undefined : exists(currentResult(q)),
          ),
        ),
      ),
  );
  return row !== undefined;
}

/** Open work still belongs to its run while leased or while a delivered result awaits import. */
export async function runnerHoldsRunWork(
  store: Db,
  runId: string,
  now: number,
  cancelled = false,
): Promise<boolean> {
  return store.run((q) => runnerHoldsRunWorkSteps(q, runId, now, cancelled));
}

export function* runnerWorkHasResultSteps(q: Q, runId: string) {
  const { runnerWork } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(runnerWork)
      .where(
        and(eq(runnerWork.runId, runId), isNull(runnerWork.endedAt), exists(currentResult(q))),
      ),
  );
  return row !== undefined;
}

/** The current command delivered a result that its owning run has not imported yet. */
export async function runnerWorkHasResult(store: Db, runId: string): Promise<boolean> {
  return store.run((q) => runnerWorkHasResultSteps(q, runId));
}
