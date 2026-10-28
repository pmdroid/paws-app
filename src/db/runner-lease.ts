import type { Database } from "bun:sqlite";
import { RUNNER_LEASE_GRACE_MS, RUNNER_OFFLINE_BUDGET_MS } from "../runner-protocol";

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

/**
 * Whether Paws may release the runner slot of `runId` without fencing work the runner still does.
 * True when no work is open, when the lease is past the grace, when the runner sent its result
 * for the current command, or when the runner acknowledged a cancel Paws sent for it. The halt
 * core (restart, stop, take-over) waits for this before it releases a runner it did not ask to stop.
 */
export function runnerWorkSettled(db: Database, runId: string, now: number): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM runner_work w WHERE w.run_id=?1 AND w.ended_at IS NULL AND w.lease_until>?2
         AND NOT EXISTS(SELECT 1 FROM runner_result r
           WHERE r.run_id=w.run_id AND r.generation=w.generation AND r.command_id=w.command_id)
         AND NOT EXISTS(SELECT 1 FROM runner_command c WHERE c.run_id=w.run_id
           AND c.generation=w.generation AND c.runner_id=w.runner_id AND c.kind='cancel'
           AND c.acknowledged_at IS NOT NULL)`,
      )
      .get(runId, runnerLeaseCutoff(now)) === null
  );
}

/** How often a running Paws records that it is alive. */
export const PAWS_ALIVE_INTERVAL_MS = 15_000;

/** Record that Paws is alive at `now`. Startup reads it to tell how long Paws was down. */
export function markPawsAlive(db: Database, now: number): void {
  db.run("INSERT INTO paws_alive(id,at) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET at=MAX(at,?1)", [
    now,
  ]);
}

/** When Paws last recorded that it was alive, or null when it never has. */
export function pawsAliveAt(db: Database): number | null {
  return db.query<{ at: number }, []>("SELECT at FROM paws_alive WHERE id=1").get()?.at ?? null;
}

/**
 * On start, move the lease of open runner work forward by the time Paws was down, so downtime
 * does not count against it. The shift is capped by `budgetMs` and by each command's
 * `expiresAt`. Work the runner gave up on stays given up: a row with a result, an acknowledged
 * cancel, or a lease already past the grace when Paws was last alive is not extended. Returns the
 * shift applied. Run inside the startup transaction; it records Paws alive at `now`.
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
  db.run(
    `UPDATE runner_work AS w SET lease_until=MAX(w.lease_until,
       MIN(w.lease_until+?1, (SELECT c.expires_at FROM runner_command c WHERE c.id=w.command_id)))
     WHERE w.ended_at IS NULL AND w.lease_until>?2
     AND EXISTS(SELECT 1 FROM runner_command c WHERE c.id=w.command_id)
     AND NOT EXISTS(SELECT 1 FROM runner_result r
       WHERE r.run_id=w.run_id AND r.generation=w.generation AND r.command_id=w.command_id)
     AND NOT EXISTS(SELECT 1 FROM runner_command c WHERE c.run_id=w.run_id
       AND c.generation=w.generation AND c.runner_id=w.runner_id AND c.kind='cancel'
       AND c.acknowledged_at IS NOT NULL)`,
    [shift, runnerLeaseCutoff(aliveAt)],
  );
  return shift;
}
