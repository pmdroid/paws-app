import type { Database } from "bun:sqlite";
import type { CiRoundCheck } from "./ci-rounds";
import { gatherPullFeedback, type PullFeedbackWait } from "./pull-comments";

export type PullCiOutcome = "restarted" | "asked" | "dropped" | "cleared";

export type PullCiFailedCheck = {
  name: string;
  url: string | null;
  logTail?: string | null;
  failsOnBase?: boolean;
};

export type PullCiFailureRecord = {
  itemId: string;
  head: string;
  pullNumber: number;
  itemVersion: number;
  failedChecks: PullCiFailedCheck[];
  checks: CiRoundCheck[];
  observedAt: number;
  handledAt: number | null;
  outcome: PullCiOutcome | null;
};

type Row = {
  item_id: string;
  head: string;
  pull_number: number;
  item_version: number;
  failed_checks: string;
  checks: string;
  observed_at: number;
  handled_at: number | null;
  outcome: PullCiOutcome | null;
};

export type PullCiObservation = "recorded" | "known";

const TERMINAL = new Set<PullCiOutcome>(["restarted", "asked"]);

export function recordPullCiFailure(
  db: Database,
  failure: Omit<PullCiFailureRecord, "handledAt" | "outcome">,
  wait: PullFeedbackWait,
): PullCiObservation {
  settleOtherHeads(db, failure.itemId, failure.head, failure.observedAt);
  const existing = db
    .query<Row, [string, string]>("SELECT * FROM pull_ci_failure WHERE item_id = ? AND head = ?")
    .get(failure.itemId, failure.head);
  const values = [
    failure.pullNumber,
    failure.itemVersion,
    JSON.stringify(failure.failedChecks),
    JSON.stringify(failure.checks),
  ];
  if (existing !== null && (existing.handled_at === null || TERMINAL.has(existing.outcome!))) {
    if (existing.handled_at === null)
      db.run(
        `UPDATE pull_ci_failure SET pull_number = ?, item_version = ?, failed_checks = ?, checks = ?
         WHERE item_id = ? AND head = ?`,
        [...values, failure.itemId, failure.head],
      );
    return "known";
  }
  db.run(
    `INSERT INTO pull_ci_failure (pull_number, item_version, failed_checks, checks, item_id, head, observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (item_id, head) DO UPDATE SET pull_number = excluded.pull_number,
       item_version = excluded.item_version, failed_checks = excluded.failed_checks,
       checks = excluded.checks, observed_at = excluded.observed_at, handled_at = NULL, outcome = NULL`,
    [...values, failure.itemId, failure.head, failure.observedAt],
  );
  gatherPullFeedback(
    db,
    failure.itemId,
    failure.observedAt,
    wait,
    `pull-comments:${failure.itemId}:ci:${failure.head}:${failure.observedAt}`,
  );
  return "recorded";
}

export function clearPullCiFailures(db: Database, itemId: string, head: string, now: number): void {
  settleOtherHeads(db, itemId, head, now);
  db.run(
    `UPDATE pull_ci_failure SET handled_at = ?, outcome = 'cleared'
     WHERE item_id = ? AND head = ? AND handled_at IS NULL`,
    [now, itemId, head],
  );
}

export function pendingPullCiFailures(db: Database, itemId: string): PullCiFailureRecord[] {
  return db
    .query<Row, [string]>(
      `SELECT * FROM pull_ci_failure WHERE item_id = ? AND handled_at IS NULL
       ORDER BY observed_at, head`,
    )
    .all(itemId)
    .map(mapRow);
}

export function getPullCiFailure(
  db: Database,
  itemId: string,
  head: string,
): PullCiFailureRecord | null {
  const row = db
    .query<Row, [string, string]>("SELECT * FROM pull_ci_failure WHERE item_id = ? AND head = ?")
    .get(itemId, head);
  return row === null ? null : mapRow(row);
}

export function settlePullCiFailures(
  db: Database,
  failures: readonly Pick<PullCiFailureRecord, "itemId" | "head">[],
  outcome: PullCiOutcome,
  now: number,
): number {
  let settled = 0;
  for (const failure of failures)
    settled += db.run(
      `UPDATE pull_ci_failure SET handled_at = ?, outcome = ?
       WHERE item_id = ? AND head = ? AND handled_at IS NULL`,
      [now, outcome, failure.itemId, failure.head],
    ).changes;
  return settled;
}

function settleOtherHeads(db: Database, itemId: string, head: string, now: number): void {
  db.run(
    `UPDATE pull_ci_failure SET handled_at = ?, outcome = 'dropped'
     WHERE item_id = ? AND head != ? AND handled_at IS NULL`,
    [now, itemId, head],
  );
}

function mapRow(row: Row): PullCiFailureRecord {
  return {
    itemId: row.item_id,
    head: row.head,
    pullNumber: row.pull_number,
    itemVersion: row.item_version,
    failedChecks: JSON.parse(row.failed_checks) as PullCiFailedCheck[],
    checks: JSON.parse(row.checks) as CiRoundCheck[],
    observedAt: row.observed_at,
    handledAt: row.handled_at,
    outcome: row.outcome,
  };
}
