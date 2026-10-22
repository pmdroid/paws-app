import type { Database } from "bun:sqlite";

export type CiRoundCheck = {
  name: string;
  state: "passed" | "failed" | "running" | "skipped" | "neutral";
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  logTail: string | null;
  logSource: "actions" | "summary" | null;
};

/** What Paws did after a failed round: sent it back to the agent, or asked in Linear. */
export type CiRoundAction = "sent_back" | "asked";

/** The checks Paws read on one pull request head. A head gets one round. */
export type CiRound = {
  itemId: string;
  head: string;
  outcome: "running" | "failed" | "passed";
  checks: CiRoundCheck[];
  action: CiRoundAction | null;
  fixAttempt: number | null;
  fixLimit: number | null;
  startedAt: number;
  updatedAt: number;
};

type RoundRow = {
  item_id: string;
  head: string;
  outcome: CiRound["outcome"];
  checks: string;
  action: CiRoundAction | null;
  fix_attempt: number | null;
  fix_limit: number | null;
  started_at: number;
  updated_at: number;
};

/**
 * Records the latest checks on `head`. A later read of the same head replaces them.
 * `outcome` is merge readiness's CI verdict, so a required check that has not
 * reported yet keeps the round running even when every reported check passed.
 */
export function recordCiRound(
  db: Database,
  input: {
    itemId: string;
    head: string;
    outcome: CiRound["outcome"];
    checks: readonly CiRoundCheck[];
    now: number;
  },
): void {
  const outcome = input.outcome;
  db.run(
    `INSERT INTO ci_round (item_id, head, outcome, checks, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (item_id, head) DO UPDATE SET
       outcome = excluded.outcome, checks = excluded.checks, updated_at = excluded.updated_at`,
    [input.itemId, input.head, outcome, JSON.stringify(input.checks), input.now, input.now],
  );
}

/** Notes what Paws did after the failed round on `head`. */
export function setCiRoundAction(
  db: Database,
  input: {
    itemId: string;
    head: string;
    action: CiRoundAction;
    fixAttempt: number | null;
    fixLimit: number;
  },
): void {
  db.run(
    `UPDATE ci_round SET action = ?, fix_attempt = ?, fix_limit = ? WHERE item_id = ? AND head = ?`,
    [input.action, input.fixAttempt, input.fixLimit, input.itemId, input.head],
  );
}

/** Rounds oldest first. */
export function listCiRounds(db: Database, itemIds?: readonly string[]): CiRound[] {
  const rows =
    itemIds === undefined
      ? db.query<RoundRow, []>(`SELECT * FROM ci_round ORDER BY started_at, rowid`).all()
      : db
          .query<RoundRow, [string]>(
            `SELECT * FROM ci_round WHERE item_id IN (SELECT value FROM json_each(?))
             ORDER BY started_at, rowid`,
          )
          .all(JSON.stringify(itemIds));
  return rows.map((row) => ({
    itemId: row.item_id,
    head: row.head,
    outcome: row.outcome,
    checks: JSON.parse(row.checks) as CiRoundCheck[],
    action: row.action,
    fixAttempt: row.fix_attempt,
    fixLimit: row.fix_limit,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  }));
}
