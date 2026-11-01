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
    `INSERT INTO rebase_return (job_id, activation_id, item_id, candidate, reason, base, files, recorded_at)
     VALUES (?1, COALESCE((SELECT activation_id FROM job WHERE id=?1),?1), ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (job_id,activation_id) DO NOTHING`,
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

export function countRebaseReturns(
  db: Database,
  itemId: string,
  sinceActivationId: number,
): number {
  const row = db
    .query<{ n: number }, [string, number]>(
      "SELECT COUNT(*) AS n FROM rebase_return WHERE item_id = ? AND activation_id >= ?",
    )
    .get(itemId, sinceActivationId);
  return Number(row?.n ?? 0);
}

export function listRebaseReturns(
  db: Database,
  itemId: string,
  sinceActivationId: number,
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
       FROM rebase_return WHERE item_id = ? AND activation_id >= ? ORDER BY activation_id`,
    )
    .all(itemId, sinceActivationId)
    .map((row) => ({
      ...row,
      files: row.files === null ? null : (JSON.parse(row.files) as string[]),
    }));
}

/** Whether the item already went back to the agent for a rebase of `candidate`. */
export function rebaseReturnedFor(db: Database, itemId: string, candidate: string): boolean {
  return (
    db
      .query("SELECT 1 FROM rebase_return WHERE item_id = ? AND candidate = ? LIMIT 1")
      .get(itemId, candidate) !== null
  );
}
