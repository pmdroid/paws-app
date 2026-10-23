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

export const VISUAL_REVIEW_ROUNDS = 3;

export const VISUAL_REVIEW_CONTINUE_OPTIONS = ["Keep going"] as const;

export const VISUAL_REVIEW_DESCRIBE =
  "Reply with the changes you want to the screens. The task keeps waiting.";

export function visualReviewContinueQuestion(rounds: number): string {
  return `Visual review: ${rounds} rounds of changes so far. Keep going, or stop the task in Linear. A reply other than Keep going goes to the agent with the last feedback.`;
}

export type VisualReviewKind = "review" | "continue";

export type VisualReviewOutcome = "accepted" | "changes_requested" | "stale" | "continued";

export type StoredVisualReview = {
  questionId: string;
  itemId: string;
  checkId: string;
  evidenceIds: string[];
  createdAt: number;
  kind: VisualReviewKind;
  outcome: VisualReviewOutcome | null;
  answeredBy: string | null;
  answeredAt: number | null;
  feedback: string | null;
  headCommit: string | null;
};

type VisualReviewRow = {
  question_id: string;
  item_id: string;
  check_id: string;
  evidence_ids: string;
  created_at: number;
  kind: VisualReviewKind;
  outcome: VisualReviewOutcome | null;
  answered_by: string | null;
  answered_at: number | null;
  feedback: string | null;
  head_commit: string | null;
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

export function openVisualReviewContinue(
  db: Database,
  input: { itemId: string; runId: string | null; sessionId: string; checkId: string; now: number },
): StoredQuestion {
  const question = openQuestion(db, {
    itemId: input.itemId,
    runId: input.runId,
    sessionId: input.sessionId,
    body: visualReviewContinueQuestion(VISUAL_REVIEW_ROUNDS),
    options: [...VISUAL_REVIEW_CONTINUE_OPTIONS],
    now: input.now,
  });
  db.run(
    "INSERT INTO visual_review (question_id, item_id, check_id, evidence_ids, created_at, kind) VALUES (?, ?, ?, '[]', ?, 'continue')",
    [question.id, input.itemId, input.checkId, input.now],
  );
  return question;
}

export function recordVisualReviewAnswer(
  db: Database,
  questionId: string,
  input: {
    outcome: VisualReviewOutcome;
    answeredBy: string;
    now: number;
    feedback?: string;
    headCommit?: string;
  },
): void {
  db.run(
    "UPDATE visual_review SET outcome = ?, answered_by = ?, answered_at = ?, feedback = ?, head_commit = ? WHERE question_id = ?",
    [
      input.outcome,
      input.answeredBy,
      input.now,
      input.feedback ?? null,
      input.headCommit ?? null,
      questionId,
    ],
  );
}

export function markVisualReviewStale(db: Database, questionId: string): void {
  db.run(
    "UPDATE visual_review SET outcome = 'stale' WHERE question_id = ? AND outcome = 'accepted'",
    [questionId],
  );
}

export function acceptedVisualReviews(db: Database, itemId: string): StoredVisualReview[] {
  return db
    .query<VisualReviewRow, [string]>(
      "SELECT * FROM visual_review WHERE item_id = ? AND kind = 'review' AND outcome = 'accepted' ORDER BY answered_at, rowid",
    )
    .all(itemId)
    .map(mapVisualReview);
}

export function rejectedEvidenceIds(db: Database, itemId: string): Set<string> {
  const rows = db
    .query<VisualReviewRow, [string]>(
      "SELECT * FROM visual_review WHERE item_id = ? AND outcome IN ('changes_requested', 'stale')",
    )
    .all(itemId);
  return new Set(rows.flatMap((row) => mapVisualReview(row).evidenceIds));
}

export function visualReviewRounds(db: Database, itemId: string, checkId: string): number {
  const row = db
    .query<{ changes: number; continued: number }, [string, string]>(
      `SELECT
         COALESCE(SUM(kind = 'review' AND outcome = 'changes_requested'), 0) AS changes,
         COALESCE(SUM(kind = 'continue' AND outcome = 'continued'), 0) AS continued
       FROM visual_review WHERE item_id = ? AND check_id = ?`,
    )
    .get(itemId, checkId);
  return (row?.changes ?? 0) - VISUAL_REVIEW_ROUNDS * (row?.continued ?? 0);
}

export function lastVisualReviewFeedback(
  db: Database,
  itemId: string,
  checkId: string,
): { questionId: string; feedback: string | null } | null {
  return db
    .query<{ questionId: string; feedback: string | null }, [string, string]>(
      `SELECT question_id AS questionId, feedback FROM visual_review
       WHERE item_id = ? AND check_id = ? AND kind = 'review' AND outcome = 'changes_requested'
       ORDER BY answered_at DESC, rowid DESC LIMIT 1`,
    )
    .get(itemId, checkId);
}

export type VisualReviewAnswer =
  | { kind: "accept" }
  | { kind: "changes"; feedback: string }
  | { kind: "describe" };

export function parseVisualReviewAnswer(answer: string): VisualReviewAnswer {
  const text = answer.trim();
  if (/^(accept|accepted|approve|approved)[.!]?$/i.test(text)) return { kind: "accept" };
  const feedback = text.replace(/^request changes\s*[:.\-–—]?\s*/i, "").trim();
  return feedback === "" ? { kind: "describe" } : { kind: "changes", feedback };
}

export function visualReviewAcceptedHandoff(checkId: string): string {
  return [
    "Handoff from the previous session.",
    `The visual review of check ${checkId} was accepted in Linear. The check passes for the files it covered.`,
    "Finish Closeout and open the pull request. Do not change files under the check's paths unless you have to; a change there needs another visual review.",
  ].join("\n");
}

export type VisualReviewMarkedFile = {
  path: string;
  displayName: string;
  evidenceId: string;
  headCommit: string;
};

export function visualReviewChangesHandoff(
  checkId: string,
  feedback: string,
  marked: readonly VisualReviewMarkedFile[] = [],
): string {
  return [
    "Handoff from the previous session.",
    `The reviewer requested changes in the visual review of check ${checkId}:`,
    feedback,
    ...(marked.length
      ? [
          "The reviewer drew on these screenshots to show what to change. Open each image and look at the marks:",
          ...marked.map(
            (file) =>
              `- ${file.path}: ${file.displayName} (evidence ${file.evidenceId}, published at commit ${file.headCommit.slice(0, 7)})`,
          ),
        ]
      : []),
    `The screenshots you published for ${checkId} no longer count. Fix the screens, then publish new screenshots with publish_artifact and checkId "${checkId}". Paws asks for another visual review.`,
  ].join("\n");
}

export function visualReviewStaleHandoff(checkId: string): string {
  return [
    "Handoff from the previous session.",
    `Files under the paths of check ${checkId} changed after its visual review was accepted, so that review no longer counts.`,
    `Publish new screenshots of the changed screens with publish_artifact and checkId "${checkId}". Paws asks for another visual review.`,
  ].join("\n");
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
    kind: row.kind,
    outcome: row.outcome,
    answeredBy: row.answered_by,
    answeredAt: row.answered_at,
    feedback: row.feedback,
    headCommit: row.head_commit,
  };
}
