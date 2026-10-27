import type { Database } from "bun:sqlite";

/**
 * What a fix changed on a high-risk pull request since the head a person approved. `paths` are
 * the changed files a high-risk glob matched: empty means the approval carried over to `head`,
 * otherwise Paws asks again about those paths only.
 */
export type RiskFix = {
  itemId: string;
  head: string;
  approvedHead: string;
  /** The risk link ask whose approval this head was compared with. */
  approvedQuestionId: string;
  /** Every file the fix changed since the approved head, sorted. */
  changed: string[];
  paths: string[];
  recordedAt: number;
};

/** Records the comparison for a head. A repeat for the same head replaces it. */
export function saveRiskFix(db: Database, fix: RiskFix): void {
  db.run(
    `INSERT INTO risk_fix (item_id, head_sha, approved_head, approved_question_id, changed, paths, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (item_id, head_sha) DO UPDATE SET
       approved_head = excluded.approved_head, approved_question_id = excluded.approved_question_id,
       changed = excluded.changed, paths = excluded.paths, recorded_at = excluded.recorded_at`,
    [
      fix.itemId,
      fix.head,
      fix.approvedHead,
      fix.approvedQuestionId,
      JSON.stringify(fix.changed),
      JSON.stringify(fix.paths),
      fix.recordedAt,
    ],
  );
}

/** Forgets the comparison for a head, as when Paws can no longer read the fix. */
export function deleteRiskFix(db: Database, itemId: string, head: string): void {
  db.run("DELETE FROM risk_fix WHERE item_id = ? AND head_sha = ?", [itemId, head]);
}

type Row = {
  itemId: string;
  head: string;
  approvedHead: string;
  approvedQuestionId: string;
  changed: string;
  paths: string;
  recordedAt: number;
};

const SELECT = `SELECT item_id AS itemId, head_sha AS head, approved_head AS approvedHead,
  approved_question_id AS approvedQuestionId, changed, paths, recorded_at AS recordedAt
  FROM risk_fix`;

export function getRiskFix(db: Database, itemId: string, head: string): RiskFix | null {
  const row = db
    .query<Row, [string, string]>(`${SELECT} WHERE item_id = ? AND head_sha = ?`)
    .get(itemId, head);
  return row ? fromRow(row) : null;
}

/** The most recently recorded fix of the item. */
export function latestRiskFix(db: Database, itemId: string): RiskFix | null {
  const row = db
    .query<Row, [string]>(
      `${SELECT} WHERE item_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1`,
    )
    .get(itemId);
  return row ? fromRow(row) : null;
}

function fromRow(row: Row): RiskFix {
  return {
    ...row,
    changed: JSON.parse(row.changed) as string[],
    paths: JSON.parse(row.paths) as string[],
  };
}
