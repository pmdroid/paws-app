import type { Database } from "bun:sqlite";

export type RebaseReturn = {
  itemId: string;
  jobId: number;
  candidate: string | null;
  reason: "merge" | "github_queue" | "linear";
};

export function recordRebaseReturn(db: Database, row: RebaseReturn): void {
  db.run(
    `INSERT INTO rebase_return (job_id, item_id, candidate, reason) VALUES (?, ?, ?, ?)
     ON CONFLICT (job_id) DO NOTHING`,
    [row.jobId, row.itemId, row.candidate, row.reason],
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
