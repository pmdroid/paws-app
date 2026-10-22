import type { Database } from "bun:sqlite";
import { openQuestion, type StoredQuestion } from "./store";

/** The question Paws asks when an `approval: human` check has its files. */
export const VISUAL_REVIEW_QUESTION = "Visual review: accept, or describe the changes you want.";

export const VISUAL_REVIEW_OPTIONS = ["Accept", "Request changes"] as const;

/** What `publish_artifact` tells the agent once the review is asked. */
export const VISUAL_REVIEW_WAIT =
  "Waiting for a visual review in Linear. Stop here; the task resumes with the answer.";

/** Paws reminds once after this long without an answer. There is no timeout. */
export const VISUAL_REVIEW_REMINDER_MS = 24 * 60 * 60 * 1000;

export const VISUAL_REVIEW_REMINDER =
  "Still waiting for a visual review. Accept the screenshots, or describe the changes you want.";

export const VISUAL_REVIEW_ANSWERERS =
  "Only the person who delegated this issue or the Linear project's lead can answer this visual review. The task keeps waiting.";

export type StoredVisualReview = {
  questionId: string;
  itemId: string;
  checkId: string;
  evidenceIds: string[];
  createdAt: number;
};

type VisualReviewRow = {
  question_id: string;
  item_id: string;
  check_id: string;
  evidence_ids: string;
  created_at: number;
};

/** Opens the review question and records the files it shows. Call inside a transaction. */
export function openVisualReview(
  db: Database,
  input: {
    itemId: string;
    runId: string;
    sessionId: string;
    checkId: string;
    evidenceIds: readonly string[];
    now: number;
  },
): { question: StoredQuestion; review: StoredVisualReview } {
  const question = openQuestion(db, {
    itemId: input.itemId,
    runId: input.runId,
    sessionId: input.sessionId,
    body: VISUAL_REVIEW_QUESTION,
    options: [...VISUAL_REVIEW_OPTIONS],
    now: input.now,
  });
  db.run(
    "INSERT INTO visual_review (question_id, item_id, check_id, evidence_ids, created_at) VALUES (?, ?, ?, ?, ?)",
    [question.id, input.itemId, input.checkId, JSON.stringify(input.evidenceIds), input.now],
  );
  return { question, review: getVisualReview(db, question.id)! };
}

export function getVisualReview(db: Database, questionId: string): StoredVisualReview | null {
  const row = db
    .query<VisualReviewRow, [string]>("SELECT * FROM visual_review WHERE question_id = ?")
    .get(questionId);
  return row === null ? null : mapVisualReview(row);
}

/** Files of this check that an earlier visual review already showed. */
export function reviewedEvidenceIds(db: Database, itemId: string, checkId: string): Set<string> {
  const rows = db
    .query<VisualReviewRow, [string, string]>(
      "SELECT * FROM visual_review WHERE item_id = ? AND check_id = ?",
    )
    .all(itemId, checkId);
  return new Set(rows.flatMap((row) => mapVisualReview(row).evidenceIds));
}

/** The question text, then each file inline when Linear has it, or its Paws link. */
export function visualReviewBody(
  files: readonly { displayName: string; link: string; assetUrl?: string }[],
): string {
  const shown = files.map((file) => {
    const label = file.displayName.replace(/[\\[\]]/g, "\\$&");
    return file.assetUrl === undefined
      ? `[${label}](<${file.link}>)`
      : `![${label}](<${file.assetUrl}>)`;
  });
  return [
    VISUAL_REVIEW_QUESTION,
    ...shown,
    "Pick Accept, or reply with the changes you want.",
  ].join("\n\n");
}

function mapVisualReview(row: VisualReviewRow): StoredVisualReview {
  return {
    questionId: row.question_id,
    itemId: row.item_id,
    checkId: row.check_id,
    evidenceIds: JSON.parse(row.evidence_ids) as string[],
    createdAt: row.created_at,
  };
}
