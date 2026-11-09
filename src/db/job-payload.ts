import type { Database } from "bun:sqlite";
import { and, eq, gt, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import { itemVersionOf, jsonItemId, type Job } from "./jobs";

function leased(q: Q, job: Job, now: number) {
  const { job: jobTable } = q.t;
  return and(
    eq(jobTable.id, job.id),
    eq(jobTable.status, "running"),
    eq(jobTable.lockedBy, job.lockedBy ?? sql`NULL`),
    gt(jobTable.lockedUntil, now),
  );
}

export function* replaceLeasedJobPayloadSteps(q: Q, job: Job, payload: unknown, now: number) {
  const { job: jobTable } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(jobTable)
      .set({ payload: q.dialect === "sqlite" ? JSON.stringify(payload) : payload })
      .where(leased(q, job, now))
      .returning({ id: jobTable.id }),
  );
  return rows.length > 0;
}

/** Replace transient payload bookkeeping without refreshing the job's item-version fence. */
export function replaceLeasedJobPayload(
  db: Database,
  job: Job,
  payload: unknown,
  now: number,
): boolean {
  return settled(sqliteDb(db).run((q) => replaceLeasedJobPayloadSteps(q, job, payload, now)));
}

export function* refreshVerificationJobVersionSteps(q: Q, job: Job, runId: string, now: number) {
  const { job: jobTable } = q.t;
  const itemId = jsonItemId(q, sql`${jobTable.payload}`);
  const rows = yield* q.all(
    q.orm
      .update(jobTable)
      .set({ itemVersion: itemVersionOf(q, sql`${jobTable.payload}`) })
      .where(
        and(
          leased(q, job, now),
          sql`EXISTS(SELECT 1 FROM work_item i WHERE i.id=${itemId}
              AND i.current_run_id=${runId} AND i.cancel_requested=0 AND i.state IN ('verifying','merge_queue'))`,
        ),
      )
      .returning({ id: jobTable.id }),
  );
  return rows.length > 0;
}

/** A parked verification request survives version changes within the same run, but not a restart. */
export function refreshVerificationJobVersion(
  db: Database,
  job: Job,
  runId: string,
  now: number,
): boolean {
  return settled(sqliteDb(db).run((q) => refreshVerificationJobVersionSteps(q, job, runId, now)));
}
