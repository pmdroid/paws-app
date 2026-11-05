import type { Database } from "bun:sqlite";

export type FindingDecision = "fixed" | "declined";

export type SuggestedFindingRecord = {
  itemId: string;
  findingId: string;
  reviewId: string;
  location: string;
  severity: string;
  explanation: string;
  handedAt: number;
  decision: FindingDecision | null;
  reason: string | null;
  head: string | null;
  decidedAt: number | null;
};

export type SuggestionTurnRecord = {
  itemId: string;
  outcome: "started" | "skipped";
  reason: string | null;
  head: string;
  recordedAt: number;
};

type Row = {
  item_id: string;
  finding_id: string;
  review_id: string;
  location: string;
  severity: string;
  explanation: string;
  handed_at: number;
  decision: FindingDecision | null;
  reason: string | null;
  head: string | null;
  decided_at: number | null;
};

export function recordSuggestedFindings(
  db: Database,
  itemId: string,
  findings: readonly Pick<
    SuggestedFindingRecord,
    "findingId" | "reviewId" | "location" | "severity" | "explanation"
  >[],
  now: number,
): void {
  db.run(`DELETE FROM suggested_finding WHERE item_id = ? AND decision IS NULL`, [itemId]);
  for (const finding of findings)
    db.run(
      `INSERT INTO suggested_finding (item_id, finding_id, review_id, location, severity,
         explanation, handed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(item_id, finding_id) DO NOTHING`,
      [
        itemId,
        finding.findingId,
        finding.reviewId,
        finding.location,
        finding.severity,
        finding.explanation,
        now,
      ],
    );
}

export function suggestedFindings(db: Database, itemId: string): SuggestedFindingRecord[] {
  return db
    .query<Row, [string]>(
      `SELECT * FROM suggested_finding WHERE item_id = ? ORDER BY handed_at, finding_id`,
    )
    .all(itemId)
    .map(mapRow);
}

export function decideSuggestedFindings(
  db: Database,
  itemId: string,
  decisions: ReadonlyMap<string, { decision: FindingDecision; reason: string }>,
  head: string | null,
  now: number,
): number {
  let stored = 0;
  for (const [findingId, report] of decisions)
    stored += db.run(
      `UPDATE suggested_finding SET decision = ?, reason = ?, head = ?, decided_at = ?
       WHERE item_id = ? AND finding_id = ? AND decision IS NULL`,
      [report.decision, report.reason, head, now, itemId, findingId],
    ).changes;
  return stored;
}

export function recordSuggestionTurn(db: Database, record: SuggestionTurnRecord): boolean {
  return (
    db.run(
      `INSERT INTO suggestion_turn (item_id, outcome, reason, head, recorded_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT(item_id) DO NOTHING`,
      [record.itemId, record.outcome, record.reason, record.head, record.recordedAt],
    ).changes > 0
  );
}

export function getSuggestionTurn(db: Database, itemId: string): SuggestionTurnRecord | null {
  const row = db
    .query<
      {
        item_id: string;
        outcome: "started" | "skipped";
        reason: string | null;
        head: string;
        recorded_at: number;
      },
      [string]
    >(`SELECT * FROM suggestion_turn WHERE item_id = ?`)
    .get(itemId);
  return row
    ? {
        itemId: row.item_id,
        outcome: row.outcome,
        reason: row.reason,
        head: row.head,
        recordedAt: row.recorded_at,
      }
    : null;
}

function mapRow(row: Row): SuggestedFindingRecord {
  return {
    itemId: row.item_id,
    findingId: row.finding_id,
    reviewId: row.review_id,
    location: row.location,
    severity: row.severity,
    explanation: row.explanation,
    handedAt: row.handed_at,
    decision: row.decision,
    reason: row.reason,
    head: row.head,
    decidedAt: row.decided_at,
  };
}
