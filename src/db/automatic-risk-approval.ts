import type { Database } from "bun:sqlite";

export type AutomaticRiskApproval = {
  itemId: string;
  head: string;
  approvedBy: "paws:clean-reviews";
  evidenceIds: string[];
  approvedAt: number;
};

export function saveAutomaticRiskApproval(db: Database, approval: AutomaticRiskApproval): void {
  db.run(
    `INSERT INTO automatic_risk_approval (item_id, head, approved_by, evidence_ids, approved_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (item_id, head) DO UPDATE SET
      evidence_ids = excluded.evidence_ids, approved_at = excluded.approved_at
      WHERE automatic_risk_approval.evidence_ids != excluded.evidence_ids`,
    [
      approval.itemId,
      approval.head,
      approval.approvedBy,
      JSON.stringify(approval.evidenceIds),
      approval.approvedAt,
    ],
  );
}

export function getAutomaticRiskApproval(
  db: Database,
  itemId: string,
  head: string,
): AutomaticRiskApproval | null {
  const row = db
    .query<
      { approvedBy: "paws:clean-reviews"; evidenceIds: string; approvedAt: number },
      [string, string]
    >(
      `SELECT approved_by AS approvedBy, evidence_ids AS evidenceIds, approved_at AS approvedAt
     FROM automatic_risk_approval WHERE item_id = ? AND head = ?`,
    )
    .get(itemId, head);
  return row
    ? { ...row, itemId, head, evidenceIds: JSON.parse(row.evidenceIds) as string[] }
    : null;
}
