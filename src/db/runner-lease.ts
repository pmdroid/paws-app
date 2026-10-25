import type { Database } from "bun:sqlite";
import { RUNNER_LEASE_GRACE_MS } from "../runner-protocol";

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
