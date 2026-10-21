import type { Database } from "bun:sqlite";

/**
 * A fresh Closeout retry budget for one rebased head. Evidence recorded before
 * `startedAt` is in `retryBaseline` and no longer counts against the budget.
 */
export type CloseoutRound = {
  itemId: string;
  head: string;
  retryBaseline: string[];
  startedAt: number;
};

type RoundRow = {
  item_id: string;
  head: string;
  retry_baseline: string;
  started_at: number;
};

/** Records the round once per head. Returns false when the head already has one. */
export function startCloseoutRound(db: Database, input: CloseoutRound): boolean {
  return (
    db.run(
      `INSERT OR IGNORE INTO closeout_round (item_id, head, retry_baseline, started_at) VALUES (?, ?, ?, ?)`,
      [input.itemId, input.head, JSON.stringify(input.retryBaseline), input.startedAt],
    ).changes > 0
  );
}

/** Rounds after the first, oldest first. */
export function listCloseoutRounds(db: Database, itemId?: string): CloseoutRound[] {
  const rows =
    itemId === undefined
      ? db.query<RoundRow, []>(`SELECT * FROM closeout_round ORDER BY started_at, rowid`).all()
      : db
          .query<RoundRow, [string]>(
            `SELECT * FROM closeout_round WHERE item_id = ? ORDER BY started_at, rowid`,
          )
          .all(itemId);
  return rows.map((row) => ({
    itemId: row.item_id,
    head: row.head,
    retryBaseline: JSON.parse(row.retry_baseline) as string[],
    startedAt: row.started_at,
  }));
}
