import type { Database } from "bun:sqlite";

export type CiRoundCheck = {
  name: string;
  state: "passed" | "failed" | "running" | "skipped";
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  logTail: string | null;
  logSource: "actions" | "summary" | null;
};

/**
 * One failed CI read of a pull request head: every check on it, and what Paws did next.
 * `agent` sent it back for fix `fix` of `fixLimit`; `asked` asked in Linear because the
 * fixes were spent; `failed` stopped the task.
 */
export type CiRound = {
  itemId: string;
  head: string;
  runId: string | null;
  next: "agent" | "asked" | "failed";
  fix: number | null;
  fixLimit: number;
  checks: CiRoundCheck[];
  recordedAt: number;
};

type CiRoundRow = {
  item_id: string;
  head: string;
  run_id: string | null;
  next: CiRound["next"];
  fix: number | null;
  fix_limit: number;
  checks: string;
  recorded_at: number;
};

/** One round per head. A head read again replaces its checks and outcome. */
export function recordCiRound(db: Database, round: CiRound): void {
  db.run(
    `INSERT INTO ci_round (item_id, head, run_id, next, fix, fix_limit, checks, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (item_id, head) DO UPDATE SET
       run_id = excluded.run_id, next = excluded.next, fix = excluded.fix,
       fix_limit = excluded.fix_limit, checks = excluded.checks, recorded_at = excluded.recorded_at`,
    [
      round.itemId,
      round.head,
      round.runId,
      round.next,
      round.fix,
      round.fixLimit,
      JSON.stringify(round.checks),
      round.recordedAt,
    ],
  );
}

/** Oldest first. */
export function listCiRounds(db: Database, itemId?: string): CiRound[] {
  const rows =
    itemId === undefined
      ? db.query<CiRoundRow, []>(`SELECT * FROM ci_round ORDER BY recorded_at, rowid`).all()
      : db
          .query<CiRoundRow, [string]>(
            `SELECT * FROM ci_round WHERE item_id = ? ORDER BY recorded_at, rowid`,
          )
          .all(itemId);
  return rows.map((row) => ({
    itemId: row.item_id,
    head: row.head,
    runId: row.run_id,
    next: row.next,
    fix: row.fix,
    fixLimit: row.fix_limit,
    checks: JSON.parse(row.checks) as CiRoundCheck[],
    recordedAt: row.recorded_at,
  }));
}
