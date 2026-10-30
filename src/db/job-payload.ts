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

/** A parked verification request survives version changes within the same run, but not a restart. */
export function refreshVerificationJobVersion(
  db: Database,
  job: Job,
  runId: string,
  now: number,
): boolean {
  return (
    db.run(
      `UPDATE job SET item_version=(SELECT version FROM work_item WHERE id=json_extract(job.payload,'$.itemId'))
    WHERE id=? AND status='running' AND locked_by=? AND locked_until>?
    AND EXISTS(SELECT 1 FROM work_item i WHERE i.id=json_extract(job.payload,'$.itemId')
      AND i.current_run_id=? AND i.cancel_requested=0 AND i.state IN ('verifying','merge_queue'))`,
      [job.id, job.lockedBy, now, runId],
    ).changes > 0
  );
}
