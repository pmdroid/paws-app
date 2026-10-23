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
};

export function listVisualReviews(db: Database, itemId: string): VisualReviewRecord[] {
  return db
    .query<Omit<VisualReviewRecord, "evidenceIds"> & { evidenceIds: string }, [string]>(
      `SELECT v.question_id AS questionId, v.check_id AS checkId, v.evidence_ids AS evidenceIds,
         v.created_at AS createdAt, v.outcome, COALESCE(u.name, v.answered_by) AS answeredBy,
         v.answered_at AS answeredAt, v.feedback, v.head_commit AS headCommit
       FROM visual_review v LEFT JOIN workspace_user u ON u.linear_user_id = v.answered_by
       WHERE v.item_id = ? AND v.kind = 'review' ORDER BY v.created_at, v.rowid`,
    )
    .all(itemId)
    .map((row) => ({ ...row, evidenceIds: JSON.parse(row.evidenceIds) as string[] }));
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
