import type { Database } from "bun:sqlite";
import { immediate } from "./tx";
import { auditWorkspaceAccess } from "./workspace";

/**
 * Slots Paws may fill on a runner. A lowered desired value applies at once; a raised one waits
 * until the runner reports it applied the value.
 */
export function runnerHasCapacity(
  db: Database,
  runnerId: string,
  now: number,
  excludeRunId = "",
  additionalReservations = 0,
): boolean {
  const row = db
    .query<
      { capacity: number; occupied: number },
      [string, string, number, string, string, number]
    >(
      `SELECT COALESCE((SELECT MIN(capacity,COALESCE(desired,16)) FROM runner_capacity WHERE runner_id=?),1) AS capacity,
     (SELECT count(*) FROM runner_work WHERE runner_id=? AND ended_at IS NULL AND lease_until>? AND run_id<>?) +
     (SELECT count(*) FROM runner_helper WHERE runner_id=? AND ended_at IS NULL AND expires_at>?) AS occupied`,
    )
    .get(runnerId, runnerId, now, excludeRunId, runnerId, now)!;
  return row.occupied + additionalReservations < row.capacity;
}

export function runnerSlotFree(db: Database, runnerIds: readonly string[], now: number): boolean {
  const ids = runnerIds.length
    ? runnerIds
    : db
        .query<{ id: string }, [number]>(
          "SELECT id FROM runner WHERE status='active' AND revoked_at IS NULL AND last_seen_at>?",
        )
        .all(now - 60_000)
        .map((runner) => runner.id);
  return ids.some((id) => runnerHasCapacity(db, id, now));
}

/**
 * Records the capacity a runner applied and, from runners that report it, the host ceiling.
 * Returns the concurrency the runner should apply, or undefined for runners that do not report a
 * ceiling (older releases reject unknown reply fields).
 */
export function recordRunnerCapacity(
  db: Database,
  runnerId: string,
  capacity: number,
  ceiling?: number,
): number | undefined {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 16)
    throw new Error("Invalid runner capacity");
  if (
    ceiling !== undefined &&
    (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > 16 || capacity > ceiling)
  )
    throw new Error("Invalid runner capacity ceiling");
  db.run(
    `INSERT INTO runner_capacity(runner_id,capacity,ceiling) VALUES(?,?,?)
    ON CONFLICT(runner_id) DO UPDATE SET capacity=excluded.capacity,ceiling=excluded.ceiling`,
    [runnerId, capacity, ceiling ?? null],
  );
  if (ceiling === undefined) return undefined;
  const desired = db
    .query<{ desired: number | null }, [string]>(
      "SELECT desired FROM runner_capacity WHERE runner_id=?",
    )
    .get(runnerId)?.desired;
  return Math.min(desired ?? ceiling, ceiling);
}

export class RunnerConcurrencyError extends Error {}

/** Stores the concurrency an owner or admin chose, from 1 up to the ceiling the runner reported. */
export function setRunnerConcurrency(
  db: Database,
  input: {
    runnerId: string;
    workspaceId: string;
    userId: string;
    concurrency: number;
    now: number;
  },
): void {
  immediate(db, () => {
    const row = db
      .query<{ ceiling: number | null }, [string, string]>(
        `SELECT c.ceiling FROM runner r LEFT JOIN runner_capacity c ON c.runner_id=r.id
        WHERE r.id=? AND r.workspace_id=? AND r.revoked_at IS NULL`,
      )
      .get(input.runnerId, input.workspaceId);
    if (!row) throw new Error("Runner is unavailable.");
    if (row.ceiling === null)
      throw new RunnerConcurrencyError(
        "Update this runner to set its concurrency from Paws. It uses its config value until then.",
      );
    if (
      !Number.isSafeInteger(input.concurrency) ||
      input.concurrency < 1 ||
      input.concurrency > row.ceiling
    )
      throw new RunnerConcurrencyError(
        `Concurrency must be from 1 to ${row.ceiling}, the limit set on the host.`,
      );
    db.run("UPDATE runner_capacity SET desired=? WHERE runner_id=?", [
      input.concurrency,
      input.runnerId,
    ]);
    auditWorkspaceAccess(db, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      action: "runner.concurrency",
      subject: input.runnerId,
      now: input.now,
    });
  });
}
