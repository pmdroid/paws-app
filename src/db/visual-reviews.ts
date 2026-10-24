import type { Database } from "bun:sqlite";
import { getLinearConversationSource } from "./conversations";

export type VisualReviewRecord = {
  questionId: string;
  checkId: string;
  evidenceIds: string[];
  createdAt: number;
  outcome: "accepted" | "changes_requested" | "stale" | null;
  answeredBy: string | null;
  answeredAt: number | null;
  feedback: string | null;
  headCommit: string | null;
  /** Files that carried an earlier approval over. `approvedBy` is the approver's name when known. */
  carried: VisualReviewCarriedFile[];
};

export type VisualReviewCarriedFile = {
  evidenceId: string;
  fromEvidenceId: string;
  /** Question id of the review a person accepted. */
  approvalId: string;
  approvedBy: string;
  approvedAt: number;
  match: "identical" | "similar";
};

export function listVisualReviews(db: Database, itemId: string): VisualReviewRecord[] {
  return db
    .query<
      Omit<VisualReviewRecord, "evidenceIds" | "carried"> & {
        evidenceIds: string;
        carried: string | null;
      },
      [string]
    >(
      `SELECT v.question_id AS questionId, v.check_id AS checkId, v.evidence_ids AS evidenceIds,
         v.created_at AS createdAt, v.outcome, COALESCE(u.name, v.answered_by) AS answeredBy,
         v.answered_at AS answeredAt, v.feedback, v.head_commit AS headCommit, v.carried
       FROM visual_review v LEFT JOIN workspace_user u ON u.linear_user_id = v.answered_by
       WHERE v.item_id = ? AND v.kind = 'review' ORDER BY v.created_at, v.rowid`,
    )
    .all(itemId)
    .map((row) => ({
      ...row,
      evidenceIds: JSON.parse(row.evidenceIds) as string[],
      carried: carriedFiles(db, row.carried),
    }));
}

function carriedFiles(db: Database, value: string | null): VisualReviewCarriedFile[] {
  if (!value) return [];
  return (JSON.parse(value) as VisualReviewCarriedFile[]).map((entry) => ({
    ...entry,
    approvedBy:
      db
        .query<{ name: string }, [string]>(
          "SELECT name FROM workspace_user WHERE linear_user_id = ? AND name <> ''",
        )
        .get(entry.approvedBy)?.name ?? entry.approvedBy,
  }));
}

export function linearConversationUrl(
  db: Database,
  sessionId: string | null,
  identifier: string,
): string {
  const source = sessionId === null ? null : getLinearConversationSource(db, sessionId);
  if (source !== null) {
    try {
      const url = new URL(source);
      if (url.origin === "https://linear.app" && !url.username && !url.password) return url.href;
    } catch {}
  }
  return `https://linear.app/issue/${encodeURIComponent(identifier)}`;
}

export type VisualReviewMark = {
  id: string;
  questionId: string;
  evidenceId: string;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
};

const MARK_COLUMNS = `m.id, m.question_id AS questionId, m.evidence_id AS evidenceId,
  m.size_bytes AS sizeBytes, m.sha256, m.created_at AS createdAt`;

export function saveVisualReviewMarks(db: Database, marks: readonly VisualReviewMark[]): void {
  for (const mark of marks)
    db.run(
      "INSERT INTO visual_review_mark (id, question_id, evidence_id, size_bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [mark.id, mark.questionId, mark.evidenceId, mark.sizeBytes, mark.sha256, mark.createdAt],
    );
}

export function listVisualReviewMarks(db: Database, questionId: string): VisualReviewMark[] {
  return db
    .query<VisualReviewMark, [string]>(
      `SELECT ${MARK_COLUMNS} FROM visual_review_mark m WHERE m.question_id = ? ORDER BY m.created_at, m.rowid`,
    )
    .all(questionId);
}

export function getVisualReviewMark(
  db: Database,
  id: string,
): (VisualReviewMark & { itemId: string }) | null {
  return db
    .query<VisualReviewMark & { itemId: string }, [string]>(
      `SELECT ${MARK_COLUMNS}, v.item_id AS itemId
       FROM visual_review_mark m JOIN visual_review v ON v.question_id = m.question_id
       WHERE m.id = ?`,
    )
    .get(id);
}

export function openVisualReviewFiles(
  db: Database,
  questionId: string,
): { itemId: string; evidenceIds: string[] } | null {
  const row = db
    .query<{ itemId: string; evidenceIds: string; carried: string | null }, [string]>(
      `SELECT v.item_id AS itemId, v.evidence_ids AS evidenceIds, v.carried
       FROM visual_review v JOIN question q ON q.id = v.question_id
       WHERE v.question_id = ? AND v.kind = 'review' AND q.status = 'open' AND q.cancelled_at IS NULL`,
    )
    .get(questionId);
  if (row === null) return null;
  // Screens that carried an approval over were not asked about.
  const carried = new Set(
    (JSON.parse(row.carried ?? "[]") as { evidenceId: string }[]).map((entry) => entry.evidenceId),
  );
  return {
    itemId: row.itemId,
    evidenceIds: (JSON.parse(row.evidenceIds) as string[]).filter((id) => !carried.has(id)),
  };
}
