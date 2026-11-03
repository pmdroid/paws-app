import type { Database } from "bun:sqlite";

export type CiRerun = {
  itemId: string;
  head: string;
  runIds: number[];
  reason: string;
  at: number;
};

type CiRerunRow = {
  item_id: string;
  head_sha: string;
  run_ids: string;
  reason: string;
  at: number;
};

export function hasCiRerun(db: Database, itemId: string, head: string): boolean {
  return (
    db
      .query<{ one: number }, [string, string]>(
        "SELECT 1 AS one FROM ci_rerun WHERE item_id = ? AND head_sha = ?",
      )
      .get(itemId, head) !== null
  );
}

export function recordCiRerun(db: Database, rerun: CiRerun): boolean {
  return (
    db.run(
      `INSERT INTO ci_rerun (item_id, head_sha, run_ids, reason, at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (item_id, head_sha) DO NOTHING`,
      [rerun.itemId, rerun.head, JSON.stringify(rerun.runIds), rerun.reason, rerun.at],
    ).changes === 1
  );
}

export function listCiReruns(db: Database, itemId: string): CiRerun[] {
  return db
    .query<CiRerunRow, [string]>("SELECT * FROM ci_rerun WHERE item_id = ? ORDER BY at, head_sha")
    .all(itemId)
    .map((row) => ({
      itemId: row.item_id,
      head: row.head_sha,
      runIds: JSON.parse(row.run_ids) as number[],
      reason: row.reason,
      at: row.at,
    }));
}
