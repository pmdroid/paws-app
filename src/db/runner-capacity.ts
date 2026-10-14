import type { Database } from "bun:sqlite";

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
      `SELECT COALESCE((SELECT capacity FROM runner_capacity WHERE runner_id=?),1) AS capacity,
     (SELECT count(*) FROM runner_work WHERE runner_id=? AND ended_at IS NULL AND lease_until>? AND run_id<>?) +
     (SELECT count(*) FROM runner_helper WHERE runner_id=? AND ended_at IS NULL AND expires_at>?) AS occupied`,
    )
    .get(runnerId, runnerId, now, excludeRunId, runnerId, now)!;
  return row.occupied + additionalReservations < row.capacity;
}
