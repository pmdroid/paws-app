import type { Database } from "bun:sqlite";

export type RebaseReturn = {
  itemId: string;
  jobId: number;
  candidate: string | null;
  reason: "merge" | "github_queue" | "linear";
  /** The main commit the branch conflicted with, when known. */
  base?: string | null;
  /** The files that conflicted, when the rebase was attempted. */
  files?: readonly string[] | null;
  recordedAt?: number | null;
};

/** A recorded return, oldest first, as the rebase budget reads it. */
export type RebaseReturnRecord = {
  jobId: number;
  reason: RebaseReturn["reason"];
  base: string | null;
  files: string[] | null;
  recordedAt: number | null;
};

export function recordRebaseReturn(db: Database, row: RebaseReturn): void {
  db.run(
    `INSERT INTO rebase_return (job_id, item_id, candidate, reason, base, files, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (job_id) DO NOTHING`,
    [
      row.jobId,
      row.itemId,
      row.candidate,
      row.reason,
      row.base ?? null,
      row.files == null ? null : JSON.stringify(row.files),
      row.recordedAt ?? null,
    ],
  );
}

export function countRebaseReturns(db: Database, itemId: string, sinceJobId: number): number {
  const row = db
    .query<{ n: number }, [string, number]>(
      "SELECT COUNT(*) AS n FROM rebase_return WHERE item_id = ? AND job_id >= ?",
    )
    .get(itemId, sinceJobId);
  return Number(row?.n ?? 0);
}

export function listRebaseReturns(
  db: Database,
  itemId: string,
  sinceJobId: number,
): RebaseReturnRecord[] {
  return db
    .query<
      {
        jobId: number;
        reason: RebaseReturn["reason"];
        base: string | null;
        files: string | null;
        recordedAt: number | null;
      },
      [string, number]
    >(
      `SELECT job_id AS jobId, reason, base, files, recorded_at AS recordedAt
       FROM rebase_return WHERE item_id = ? AND job_id >= ? ORDER BY job_id`,
    )
    .all(itemId, sinceJobId)
    .map((row) => ({
      ...row,
      files: row.files === null ? null : (JSON.parse(row.files) as string[]),
    }));
}
