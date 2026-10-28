import type { Database } from "bun:sqlite";
import type { Job } from "./jobs";

/** Replace transient payload bookkeeping without refreshing the job's item-version fence. */
export function replaceLeasedJobPayload(
  db: Database,
  job: Job,
  payload: unknown,
  now: number,
): boolean {
  return (
    db.run(
      "UPDATE job SET payload=? WHERE id=? AND status='running' AND locked_by=? AND locked_until>?",
      [JSON.stringify(payload), job.id, job.lockedBy, now],
    ).changes > 0
  );
}
