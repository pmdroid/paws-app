import type { Database } from "bun:sqlite";
import { and, eq, gt, sql } from "drizzle-orm";
import type { Job } from "./jobs";
import { changes, orm } from "./orm";
import { job as jobTable } from "./schema";

function leased(job: Job, now: number) {
  return and(
    eq(jobTable.id, job.id),
    eq(jobTable.status, "running"),
    eq(jobTable.lockedBy, job.lockedBy ?? sql`NULL`),
    gt(jobTable.lockedUntil, now),
  );
}

/** Replace transient payload bookkeeping without refreshing the job's item-version fence. */
export function replaceLeasedJobPayload(
  db: Database,
  job: Job,
  payload: unknown,
  now: number,
): boolean {
  return (
    changes(
      orm(db)
        .update(jobTable)
        .set({ payload: JSON.stringify(payload) })
        .where(leased(job, now)),
    ) > 0
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
    changes(
      orm(db)
        .update(jobTable)
        .set({
          itemVersion: sql`(SELECT version FROM work_item WHERE id=json_extract(job.payload,'$.itemId'))`,
        })
        .where(
          and(
            leased(job, now),
            sql`EXISTS(SELECT 1 FROM work_item i WHERE i.id=json_extract(job.payload,'$.itemId')
              AND i.current_run_id=${runId} AND i.cancel_requested=0 AND i.state IN ('verifying','merge_queue'))`,
          ),
        ),
    ) > 0
  );
}
