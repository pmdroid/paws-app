import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  approvedVisualReviewRowsSteps,
  insertVisualReviewRowSteps,
  itemVisualReviewRowsSteps,
  lastVisualReviewFeedbackRowSteps,
  markVisualReviewRowStale,
  markVisualReviewRowStaleSteps,
  recordVisualReviewAnswerRowSteps,
  settled,
  sqliteDb,
  visualReviewRoundCountsSteps,
  visualReviewRowSteps,
  type Q,
  type Steps,
} from "../db";
import { askSteps } from "./lifecycle";
import type { StoredQuestion } from "./store";

/** The question Paws asks when an `approval: human` check has its files. */
export const VISUAL_REVIEW_QUESTION = "Visual review: accept, or describe the changes you want.";

export const VISUAL_REVIEW_OPTIONS = ["Accept", "Request changes"] as const;

/** Paws reminds once after this long without an answer. There is no timeout. */
export const VISUAL_REVIEW_REMINDER_MS = 24 * 60 * 60 * 1000;

export const VISUAL_REVIEW_REMINDER =
  "Still waiting for a visual review. Reply with the changes you want. A reply in Linear never approves the screens.";

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

export type VisualReviewFile = { id: string; link: string };

export type VisualReviewShown = {
  evidence: (VisualReviewFile & { approved?: VisualReviewFile })[];
  carried?: string[];
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

type StepsAsk = (
  q: Q,
  asker: { itemId: string; runId: string | null; sessionId: string },
  kind: "visual-review",
  body: string,
  input: { options: string[]; context?: string; now: number },
) => Steps<{ question: StoredQuestion }>;

type OpenInput = {
  itemId: string;
  runId: string | null;
  sessionId: string;
  checkId: string;
  evidenceIds: readonly string[];
  headCommit: string;
  now: number;
  /** Files among `evidenceIds` that are not asked about again. */
  carried?: readonly VisualReviewCarry[];
  shown?: VisualReviewShown;
};

/** Opens the review question and records the files it shows, in the caller's transaction. */
export function* openVisualReviewSteps(
  q: Q,
  input: OpenInput & { ask?: StepsAsk },
): Steps<{ question: StoredQuestion; review: StoredVisualReview }> {
  const { question } = yield* (input.ask ?? askSteps)(
    q,
    { itemId: input.itemId, runId: input.runId, sessionId: input.sessionId },
    "visual-review",
    VISUAL_REVIEW_QUESTION,
    {
      options: [...VISUAL_REVIEW_OPTIONS],
      ...(input.shown ? { context: JSON.stringify(input.shown) } : {}),
      now: input.now,
    },
  );
  return {
    question,
    review: yield* insertVisualReviewSteps(q, { ...input, questionId: question.id }),
  };
}

type InsertInput = {
  questionId: string;
  itemId: string;
  checkId: string;
  evidenceIds: readonly string[];
  headCommit: string;
  now: number;
  carried?: readonly VisualReviewCarry[];
};

export function* insertVisualReviewSteps(q: Q, input: InsertInput): Steps<StoredVisualReview> {
  yield* insertVisualReviewRowSteps(q, {
    questionId: input.questionId,
    itemId: input.itemId,
    checkId: input.checkId,
    evidenceIds: input.evidenceIds,
    createdAt: input.now,
    headCommit: input.headCommit,
    ...(input.carried?.length ? { carried: input.carried } : {}),
  });
  return (yield* getVisualReviewSteps(q, input.questionId))!;
}

/**
 * The detail of the visual review link ask: how many screens changed and
 * which. Linear can't show them; the item page does.
 */
export function visualReviewLinkDetail(
  checkId: string,
  screens: readonly string[],
  carried: readonly string[] = [],
): string {
  const count = screens.length === 1 ? "1 changed screen" : `${screens.length} changed screens`;
  return [
    `${count} for ${checkId}${screens.length ? `: ${screens.join(", ")}` : ""}.`,
    ...(carried.length
      ? [`Unchanged since your approval, so not asked again: ${carried.join(", ")}.`]
      : []),
  ].join(" ");
}

type CarriedInput = {
  itemId: string;
  checkId: string;
  evidenceIds: readonly string[];
  carried: readonly VisualReviewCarry[];
  headCommit: string;
  now: number;
};

export function* recordCarriedVisualReviewSteps(
  q: Q,
  input: CarriedInput,
): Steps<StoredVisualReview> {
  const latest = input.carried.reduce((last, entry) =>
    entry.approvedAt > last.approvedAt ? entry : last,
  );
  const id = `carry_${randomUUID()}`;
  yield* insertVisualReviewRowSteps(q, {
    questionId: id,
    itemId: input.itemId,
    checkId: input.checkId,
    evidenceIds: input.evidenceIds,
    createdAt: input.now,
    headCommit: input.headCommit,
    carried: input.carried,
    outcome: "accepted",
    answeredBy: latest.approvedBy,
    answeredAt: input.now,
  });
  return (yield* getVisualReviewSteps(q, id))!;
}

/**
 * Records an accepted review without a question: every file carried an
 * earlier approval. It names the latest original approver. Call inside a transaction.
 */
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

type ApprovedScreen = Omit<VisualReviewCarry, "evidenceId" | "match">;

export function* humanApprovedScreensSteps(
  q: Q,
  itemId: string,
  checkId: string,
): Steps<ApprovedScreen[]> {
  const rows = (yield* approvedVisualReviewRowsSteps(q, itemId, checkId)) as VisualReviewRow[];
  const seen = new Map<string, ApprovedScreen>();
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

/**
 * Each file a person accepted for the check, oldest approval first, with the
 * approval it came from. A carried file points at the file the person saw, so
 * screens are always compared with what a person accepted. A review that went
 * stale still counts: the person accepted those screens.
 */
export function* getVisualReviewSteps(q: Q, questionId: string): Steps<StoredVisualReview | null> {
  const row = (yield* visualReviewRowSteps(q, questionId)) as VisualReviewRow | undefined;
  return row === undefined ? null : mapVisualReview(row);
}

export function getVisualReview(db: Database, questionId: string): StoredVisualReview | null {
  return settled(sqliteDb(db).run((q) => getVisualReviewSteps(q, questionId)));
}

type ContinueInput = {
  itemId: string;
  runId: string | null;
  sessionId: string;
  checkId: string;
  now: number;
};

export function* openVisualReviewContinueSteps(
  q: Q,
  input: ContinueInput & { ask?: StepsAsk },
): Steps<StoredQuestion> {
  const { question } = yield* (input.ask ?? askSteps)(
    q,
    { itemId: input.itemId, runId: input.runId, sessionId: input.sessionId },
    "visual-review",
    visualReviewContinueQuestion(VISUAL_REVIEW_ROUNDS),
    { options: [...VISUAL_REVIEW_CONTINUE_OPTIONS], now: input.now },
  );
  yield* insertVisualReviewRowSteps(q, {
    questionId: question.id,
    itemId: input.itemId,
    checkId: input.checkId,
    evidenceIds: [],
    createdAt: input.now,
    kind: "continue",
  });
  return question;
}

type ReviewAnswer = {
  outcome: VisualReviewOutcome;
  answeredBy: string;
  now: number;
  feedback?: string;
  headCommit?: string;
};

export function* recordVisualReviewAnswerSteps(q: Q, questionId: string, input: ReviewAnswer) {
  yield* recordVisualReviewAnswerRowSteps(q, questionId, input);
}

export function* markVisualReviewStaleSteps(q: Q, questionId: string) {
  yield* markVisualReviewRowStaleSteps(q, questionId);
}

export function markVisualReviewStale(db: Database, questionId: string): void {
  markVisualReviewRowStale(db, questionId);
}

export function* acceptedVisualReviewsSteps(q: Q, itemId: string) {
  return (
    (yield* itemVisualReviewRowsSteps(q, itemId, ["accepted"], true)) as VisualReviewRow[]
  ).map(mapVisualReview);
}

export function acceptedVisualReviews(db: Database, itemId: string): StoredVisualReview[] {
  return settled(sqliteDb(db).run((q) => acceptedVisualReviewsSteps(q, itemId)));
}

export function* rejectedEvidenceIdsSteps(q: Q, itemId: string): Steps<Set<string>> {
  const rows = (yield* itemVisualReviewRowsSteps(
    q,
    itemId,
    ["changes_requested", "stale"],
    false,
  )) as VisualReviewRow[];
  return new Set(rows.flatMap((row) => mapVisualReview(row).evidenceIds));
}

export function* visualReviewRoundsSteps(q: Q, itemId: string, checkId: string): Steps<number> {
  const row = yield* visualReviewRoundCountsSteps(q, itemId, checkId);
  return row.changes - VISUAL_REVIEW_ROUNDS * row.continued;
}

export function* lastVisualReviewFeedbackSteps(q: Q, itemId: string, checkId: string) {
  return yield* lastVisualReviewFeedbackRowSteps(q, itemId, checkId);
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
    `The visual review of check ${checkId} was accepted. The check passes for the files it covered.`,
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
