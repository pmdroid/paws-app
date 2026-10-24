import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { openQuestion, type StoredQuestion } from "./store";

/** The question Paws asks when an `approval: human` check has its files. */
export const VISUAL_REVIEW_QUESTION = "Visual review: accept, or describe the changes you want.";

export const VISUAL_REVIEW_OPTIONS = ["Accept", "Request changes"] as const;

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

/**
 * A screen the reviewer was not asked about again: it matches one a person
 * already accepted, by bytes or within the pixel tolerance.
 */
export type VisualReviewCarry = {
  /** The new file the approval carries over to. */
  evidenceId: string;
  /** The file the person accepted. */
  fromEvidenceId: string;
  /** Question id of the accepted review. */
  approvalId: string;
  /** Linear user id of whoever accepted it. */
  approvedBy: string;
  approvedAt: number;
  match: "identical" | "similar";
};

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
  /** Files of `evidenceIds` that carried an earlier approval and were not asked about. */
  carried: VisualReviewCarry[];
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
  carried: string | null;
};

/** Opens the review question and records the files it shows. Call inside a transaction. */
export function openVisualReview(
  db: Database,
  input: {
    itemId: string;
    runId: string | null;
    sessionId: string;
    checkId: string;
    evidenceIds: readonly string[];
    headCommit: string;
    now: number;
    /** Files among `evidenceIds` that are not asked about again. */
    carried?: readonly VisualReviewCarry[];
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
    "INSERT INTO visual_review (question_id, item_id, check_id, evidence_ids, created_at, head_commit, carried) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      question.id,
      input.itemId,
      input.checkId,
      JSON.stringify(input.evidenceIds),
      input.now,
      input.headCommit,
      input.carried?.length ? JSON.stringify(input.carried) : null,
    ],
  );
  return { question, review: getVisualReview(db, question.id)! };
}

/**
 * Records an accepted review without a question: every file carried an
 * earlier approval. It names the latest original approver. Call inside a transaction.
 */
export function recordCarriedVisualReview(
  db: Database,
  input: {
    itemId: string;
    checkId: string;
    evidenceIds: readonly string[];
    carried: readonly VisualReviewCarry[];
    headCommit: string;
    now: number;
  },
): StoredVisualReview {
  const latest = input.carried.reduce((last, entry) =>
    entry.approvedAt > last.approvedAt ? entry : last,
  );
  const id = `carry_${randomUUID()}`;
  db.run(
    `INSERT INTO visual_review (question_id, item_id, check_id, evidence_ids, created_at, head_commit, carried,
       outcome, answered_by, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?)`,
    [
      id,
      input.itemId,
      input.checkId,
      JSON.stringify(input.evidenceIds),
      input.now,
      input.headCommit,
      JSON.stringify(input.carried),
      latest.approvedBy,
      input.now,
    ],
  );
  return getVisualReview(db, id)!;
}

/** Every file of the review carried over, so nobody was asked. */
export function carriedInFull(review: {
  evidenceIds: readonly string[];
  carried: readonly { evidenceId: string }[];
}): boolean {
  return (
    review.carried.length > 0 &&
    review.evidenceIds.every((id) => review.carried.some((entry) => entry.evidenceId === id))
  );
}

/**
 * Each file a person accepted for the check, oldest approval first, with the
 * approval it came from. A carried file points at the file the person saw, so
 * screens are always compared with what a person accepted. A review that went
 * stale still counts: the person accepted those screens.
 */
export function humanApprovedScreens(
  db: Database,
  itemId: string,
  checkId: string,
): Omit<VisualReviewCarry, "evidenceId" | "match">[] {
  const rows = db
    .query<VisualReviewRow, [string, string]>(
      `SELECT * FROM visual_review WHERE item_id = ? AND check_id = ? AND kind = 'review'
       AND outcome IN ('accepted', 'stale') AND answered_by IS NOT NULL ORDER BY answered_at, rowid`,
    )
    .all(itemId, checkId);
  const seen = new Map<string, Omit<VisualReviewCarry, "evidenceId" | "match">>();
  for (const review of rows.map(mapVisualReview)) {
    const carried = new Map(review.carried.map((entry) => [entry.evidenceId, entry]));
    for (const id of review.evidenceIds) {
      const from = carried.get(id);
      const origin = from
        ? {
            fromEvidenceId: from.fromEvidenceId,
            approvalId: from.approvalId,
            approvedBy: from.approvedBy,
            approvedAt: from.approvedAt,
          }
        : {
            fromEvidenceId: id,
            approvalId: review.questionId,
            approvedBy: review.answeredBy!,
            approvedAt: review.answeredAt ?? review.createdAt,
          };
      seen.delete(origin.fromEvidenceId);
      seen.set(origin.fromEvidenceId, origin);
    }
  }
  return [...seen.values()];
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

type ReviewFile = { displayName: string; link: string; assetUrl?: string };

/**
 * The question text, then each file inline when Linear has it, or its Paws
 * link. A changed screen shows the approved version first, beside the new one.
 * Screens that carried an approval over are named, not shown.
 */
export function visualReviewBody(
  files: readonly (ReviewFile & { approved?: ReviewFile })[],
  carried: readonly string[] = [],
): string {
  const shown = files.map((file) =>
    file.approved === undefined
      ? reviewImage(file)
      : `${reviewImage(file.approved, "approved")} ${reviewImage(file, "new")}`,
  );
  const beside = files.some((file) => file.approved !== undefined);
  return [
    VISUAL_REVIEW_QUESTION,
    ...(beside ? ["Changed screens show the approved version first, then the new one."] : []),
    ...shown,
    ...(carried.length
      ? [
          `Unchanged since your approval, so not asked again: ${carried.map(escapeLabel).join(", ")}.`,
        ]
      : []),
    "Pick Accept, or reply with the changes you want.",
  ].join("\n\n");
}

function reviewImage(file: ReviewFile, version?: string): string {
  const label = escapeLabel(version ? `${file.displayName}, ${version}` : file.displayName);
  return file.assetUrl === undefined
    ? `[${label}](<${file.link}>)`
    : `![${label}](<${file.assetUrl}>)`;
}

function escapeLabel(text: string): string {
  return text.replace(/[\\[\]]/g, "\\$&");
}

/** The one Linear line when every screen of a check carried its approval over. */
export function visualReviewCarriedNote(approvedAt: number, now: number): string {
  return `Visual review carried over: unchanged since your approval at ${approvalTime(approvedAt, now)}.`;
}

/** `21:57 UTC`, with the date in front when it was another day. */
export function approvalTime(at: number, now: number): string {
  const iso = new Date(at).toISOString();
  const time = `${iso.slice(11, 16)} UTC`;
  return iso.slice(0, 10) === new Date(now).toISOString().slice(0, 10)
    ? time
    : `${iso.slice(0, 10)} ${time}`;
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
    carried: row.carried ? (JSON.parse(row.carried) as VisualReviewCarry[]) : [],
  };
}
