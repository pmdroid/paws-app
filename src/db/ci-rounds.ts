import type { Database } from "bun:sqlite";
import { immediate } from "./tx";

/** One check on a round's head. Mirrors the GitHub module's `CiCheck`. */
export type CiRoundCheck = {
  name: string;
  state: "passed" | "failed" | "running" | "pending" | "skipped";
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  log: { source: "actions" | "summary"; text: string } | null;
};

/** What Paws did after a failing round: sent it back to the agent, or asked in Linear. */
export type CiRoundNext = "agent" | "asked";

/** The checks Paws read on one pushed head of a task's pull request. */
export type CiRound = {
  itemId: string;
  head: string;
  runId: string | null;
  pullNumber: number | null;
  pullUrl: string | null;
  checks: CiRoundCheck[];
  next: CiRoundNext | null;
  fixAttempt: number | null;
  fixLimit: number | null;
  startedAt: number;
  updatedAt: number;
};

type RoundRow = {
  item_id: string;
  head: string;
  run_id: string | null;
  pull_number: number | null;
  pull_url: string | null;
  checks: string;
  next_step: CiRoundNext | null;
  fix_attempt: number | null;
  fix_limit: number | null;
  started_at: number;
  updated_at: number;
};

/**
 * Saves the latest read of a head's checks. A check that failed earlier on the
 * same head keeps its log tail when a later read has none.
 */
export function recordCiChecks(
  db: Database,
  input: {
    itemId: string;
    head: string;
    runId: string | null;
    pullNumber: number | null;
    pullUrl: string | null;
    checks: readonly CiRoundCheck[];
    now: number;
  },
): void {
  immediate(db, () => {
    const previous = db
      .query<{ checks: string }, [string, string]>(
        `SELECT checks FROM ci_round WHERE item_id = ? AND head = ?`,
      )
      .get(input.itemId, input.head);
    const logs = new Map(
      previous === null
        ? []
        : (JSON.parse(previous.checks) as CiRoundCheck[]).map((check) => [check.name, check.log]),
    );
    const checks = input.checks.map((check) => ({
      ...check,
      log: check.log ?? (check.state === "failed" ? (logs.get(check.name) ?? null) : null),
    }));
    db.run(
      `INSERT INTO ci_round (item_id, head, run_id, pull_number, pull_url, checks, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (item_id, head) DO UPDATE SET
         checks = excluded.checks,
         run_id = COALESCE(excluded.run_id, ci_round.run_id),
         pull_number = COALESCE(excluded.pull_number, ci_round.pull_number),
         pull_url = COALESCE(excluded.pull_url, ci_round.pull_url),
         updated_at = excluded.updated_at`,
      [
        input.itemId,
        input.head,
        input.runId,
        input.pullNumber,
        input.pullUrl,
        JSON.stringify(checks),
        input.now,
        input.now,
      ],
    );
  });
}

/** Records what Paws did after the head's checks failed. */
export function markCiRound(
  db: Database,
  input: {
    itemId: string;
    head: string;
    next: CiRoundNext;
    fixAttempt: number | null;
    fixLimit: number;
    now: number;
  },
): void {
  db.run(
    `UPDATE ci_round SET next_step = ?, fix_attempt = ?, fix_limit = ?, updated_at = ?
     WHERE item_id = ? AND head = ?`,
    [input.next, input.fixAttempt, input.fixLimit, input.now, input.itemId, input.head],
  );
}

/** Rounds of the given items, oldest first. */
export function listCiRounds(db: Database, itemIds: readonly string[]): CiRound[] {
  if (itemIds.length === 0) return [];
  return db
    .query<RoundRow, string[]>(
      `SELECT * FROM ci_round WHERE item_id IN (${itemIds.map(() => "?").join(", ")})
       ORDER BY started_at, rowid`,
    )
    .all(...itemIds)
    .map((row) => ({
      itemId: row.item_id,
      head: row.head,
      runId: row.run_id,
      pullNumber: row.pull_number,
      pullUrl: row.pull_url,
      checks: JSON.parse(row.checks) as CiRoundCheck[],
      next: row.next_step,
      fixAttempt: row.fix_attempt,
      fixLimit: row.fix_limit,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    }));
}
