import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { EvidenceApproval, ResolvedEvidence } from "../closeout";
import { JOB_KIND } from "../core";
import {
  type WorkItemRecord,
  applyWorkItemEvent,
  enqueueJobOnce,
  enqueueOutboxOnce,
  getEvidence,
  getWorkItem,
  linearConversationUrl,
  latestEvidence,
  listEvidence,
  listVisualReviewMarks,
  listVisualReviews,
  saveCheckpoint,
} from "../db";
import { reviewMarkPath } from "./input-files";
import { compareScreenshots } from "./screenshot-diff";
import {
  acceptedVisualReviews,
  answerQuestion,
  approvalTime,
  carriedInFull,
  humanApprovedScreens,
  recordCarriedVisualReview,
  visualReviewCarriedNote,
  type VisualReviewCarry,
  findOpenQuestion,
  getQuestion,
  getVisualReview,
  lastVisualReviewFeedback,
  openVisualReview,
  openVisualReviewContinue,
  parseVisualReviewAnswer,
  recordVisualReviewAnswer,
  rejectedEvidenceIds,
  visualReviewAcceptedHandoff,
  visualReviewChangesHandoff,
  visualReviewRounds,
  VISUAL_REVIEW_CONTINUE_OPTIONS,
  VISUAL_REVIEW_ROUNDS,
  type StoredQuestion,
  type StoredVisualReview,
  VISUAL_REVIEW_OPTIONS,
  VISUAL_REVIEW_QUESTION,
  VISUAL_REVIEW_REMINDER,
  VISUAL_REVIEW_REMINDER_MS,
} from "../questions";

export function dueVisualReview(
  db: Database,
  itemId: string,
  requirements: readonly ResolvedEvidence[],
  approvals: readonly EvidenceApproval[],
): { requirement: ResolvedEvidence; evidenceIds: string[] } | null {
  const rejected = rejectedEvidenceIds(db, itemId);
  const evidence = latestEvidence(listEvidence(db, itemId));
  for (const requirement of requirements) {
    const evidenceIds = evidence
      .filter(
        (row) =>
          row.checkId === requirement.id &&
          !rejected.has(row.id) &&
          requirement.media.includes(row.mediaType.startsWith("video/") ? "video" : "image"),
      )
      .map((row) => row.id);
    if (evidenceIds.length < requirement.minimum) continue;
    const covered = approvals.some(
      (approval) =>
        approval.checkId === requirement.id &&
        evidenceIds.every((id) => approval.evidenceIds.includes(id)),
    );
    if (!covered) return { requirement, evidenceIds };
  }
  return null;
}

/** What happens to each file due for review. */
export type VisualReviewCarryPlan = {
  /** Files that look the same as one a person accepted. */
  carried: VisualReviewCarry[];
  /** Changed files with the approved version to show beside them. */
  approved: Map<string, string>;
};

/**
 * Matches each file to the latest file a person accepted with the same check
 * and display name. Same bytes, or pixels within tolerance, carry the
 * approval over. A changed file keeps its approved version for the question.
 * A file with no accepted predecessor is asked. Reads files, so call outside a transaction.
 */
export async function planVisualReviewCarry(
  db: Database,
  itemId: string,
  checkId: string,
  evidenceIds: readonly string[],
  evidenceRoot: string | undefined,
): Promise<VisualReviewCarryPlan> {
  const plan: VisualReviewCarryPlan = { carried: [], approved: new Map() };
  const approved = humanApprovedScreens(db, itemId, checkId).flatMap((origin) => {
    const row = getEvidence(db, origin.fromEvidenceId);
    return row ? [{ ...origin, row }] : [];
  });
  for (const id of evidenceIds) {
    const row = getEvidence(db, id);
    if (row === null) continue;
    const before = approved.findLast(
      (entry) => entry.row.displayName === row.displayName && entry.row.checkId === row.checkId,
    );
    if (before === undefined) continue;
    const { row: seen, ...origin } = before;
    if (seen.sha256 === row.sha256) {
      plan.carried.push({ ...origin, evidenceId: id, match: "identical" });
      continue;
    }
    if (
      evidenceRoot !== undefined &&
      seen.mediaType.startsWith("image/") &&
      row.mediaType.startsWith("image/") &&
      (await looksTheSame(evidenceRoot, seen.id, row.id))
    ) {
      plan.carried.push({ ...origin, evidenceId: id, match: "similar" });
      continue;
    }
    plan.approved.set(id, seen.id);
  }
  return plan;
}

async function looksTheSame(root: string, before: string, after: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      readFile(path.join(root, before)),
      readFile(path.join(root, after)),
    ]);
    return (await compareScreenshots(a, b))?.same === true;
  } catch {
    return false;
  }
}

/**
 * Every file due for review carried an approval over: records the accepted
 * review without a question and posts one line to Linear. Call inside a transaction.
 */
export function carryVisualReview(
  db: Database,
  input: {
    item: WorkItemRecord;
    sessionId: string;
    checkId: string;
    evidenceIds: readonly string[];
    carried: readonly VisualReviewCarry[];
    head: string;
    now: number;
  },
): StoredVisualReview {
  const review = recordCarriedVisualReview(db, {
    itemId: input.item.id,
    checkId: input.checkId,
    evidenceIds: input.evidenceIds,
    carried: input.carried,
    headCommit: input.head,
    now: input.now,
  });
  const approvedAt = Math.max(...input.carried.map((entry) => entry.approvedAt));
  postNote(
    db,
    input.sessionId,
    input.item,
    visualReviewCarriedNote(approvedAt, input.now),
    `visual-review-carried:${review.questionId}`,
    input.now,
  );
  return review;
}

export function askForVisualReview(
  db: Database,
  input: {
    item: WorkItemRecord;
    runId: string | null;
    sessionId: string;
    checkId: string;
    evidenceIds: readonly string[];
    base: string;
    head: string;
    publicUrl: string;
    now: number;
    /** Files among `evidenceIds` that carried an approval over and are not asked about. */
    carried?: readonly VisualReviewCarry[];
    /** For a changed file, the approved file to show beside it. */
    approved?: ReadonlyMap<string, string>;
  },
): boolean {
  const { item, sessionId } = input;
  const carried = input.carried ?? [];
  const current = getWorkItem(db, item.id);
  if (current?.state !== "running" || current.cancelRequested) return false;
  if (findOpenQuestion(db, sessionId) !== null) return false;
  const { question } = openVisualReview(db, {
    itemId: item.id,
    runId: input.runId,
    sessionId,
    checkId: input.checkId,
    evidenceIds: input.evidenceIds,
    headCommit: input.head,
    now: input.now,
    carried,
  });
  applyWorkItemEvent(db, item.id, "blocking_question");
  saveCheckpoint(db, item.id, {
    phase: "awaiting_input",
    wipCommit: input.head,
    baseSha: input.base,
  });
  const base = input.publicUrl.replace(/\/+$/, "");
  const link = (id: string) => `${base}/evidence/${encodeURIComponent(id)}`;
  const skipped = new Set(carried.map((entry) => entry.evidenceId));
  const evidence = input.evidenceIds
    .filter((id) => !skipped.has(id))
    .map((id) => {
      const approved = input.approved?.get(id);
      return {
        id,
        link: link(id),
        ...(approved ? { approved: { id: approved, link: link(approved) } } : {}),
      };
    });
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "elicitation",
    orderingKey: sessionId,
    idempotencyKey: `visual-review:${question.id}`,
    payload: {
      id: question.id,
      sessionId,
      questionId: question.id,
      body: VISUAL_REVIEW_QUESTION,
      options: [...VISUAL_REVIEW_OPTIONS],
      evidence,
      ...(carried.length ? { carried: carried.map((entry) => entry.evidenceId) } : {}),
    },
    now: input.now,
  });
  enqueueJobOnce(db, {
    queue: JOB_KIND.visualReviewReminder,
    jobKey: `visual-review-reminder:${question.id}`,
    payload: { questionId: question.id },
    runAt: input.now + VISUAL_REVIEW_REMINDER_MS,
    now: input.now,
  });
  return true;
}

/** Posts the one reminder while the review is still open and the task still waits on it. */
export function remindVisualReview(db: Database, questionId: string, now: number): boolean {
  const question = getQuestion(db, questionId);
  if (question === null || question.status !== "open" || !getVisualReview(db, questionId))
    return false;
  const item = getWorkItem(db, question.itemId);
  if (item === null || item.state !== "awaiting_input" || item.cancelRequested) return false;
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "elicitation",
    orderingKey: question.sessionId,
    idempotencyKey: `visual-review-reminder:${questionId}`,
    payload: {
      id: randomUUID(),
      sessionId: question.sessionId,
      questionId,
      body: VISUAL_REVIEW_REMINDER,
      options: [...VISUAL_REVIEW_OPTIONS],
    },
    now,
  });
  return true;
}

/** A thought on the session while the task waits, when progress posts are held back. */
export function postNote(
  db: Database,
  sessionId: string,
  item: WorkItemRecord,
  body: string,
  key: string,
  now: number,
): void {
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "activity",
    orderingKey: sessionId,
    idempotencyKey: key,
    delivery: "critical",
    payload: {
      id: randomUUID(),
      sessionId,
      itemId: item.id,
      issueId: item.linearIssueId,
      kind: "thought",
      body,
    },
    now,
  });
}

export function answerVisualReview(
  db: Database,
  input: {
    question: StoredQuestion;
    review: StoredVisualReview;
    answer: string;
    answeredBy: string;
    eventKey: string;
    now: number;
  },
): "answered" | "asked" | "describe" | "rejected" {
  const { question, review, answeredBy, now } = input;
  const item = getWorkItem(db, question.itemId);
  if (item === null || item.state !== "awaiting_input" || item.cancelRequested) return "rejected";
  const parsed = parseVisualReviewAnswer(input.answer);
  if (review.kind === "review" && parsed.kind === "describe") return "describe";
  const answered = answerQuestion(db, question.id, {
    answer: input.answer,
    answeredBy,
    eventKey: input.eventKey,
    now,
  });
  if (answered === null) return "rejected";
  if (review.kind === "continue") {
    const extra = /^keep going[.!]?$/i.test(input.answer.trim()) ? undefined : input.answer.trim();
    recordVisualReviewAnswer(db, question.id, {
      outcome: "continued",
      answeredBy,
      now,
      ...(extra ? { feedback: extra } : {}),
    });
    applyWorkItemEvent(db, item.id, "answer_received");
    return "answered";
  }
  if (parsed.kind === "accept") {
    const headCommit = review.headCommit ?? reviewedHead(db, item.id, review);
    recordVisualReviewAnswer(db, question.id, {
      outcome: "accepted",
      answeredBy,
      now,
      ...(headCommit ? { headCommit } : {}),
    });
    applyWorkItemEvent(db, item.id, "answer_received");
    return "answered";
  }
  recordVisualReviewAnswer(db, question.id, {
    outcome: "changes_requested",
    answeredBy,
    now,
    feedback: parsed.kind === "changes" ? parsed.feedback : input.answer.trim(),
  });
  if (visualReviewRounds(db, item.id, review.checkId) < VISUAL_REVIEW_ROUNDS) {
    applyWorkItemEvent(db, item.id, "answer_received");
    return "answered";
  }
  const asked = openVisualReviewContinue(db, {
    itemId: item.id,
    runId: question.runId,
    sessionId: question.sessionId,
    checkId: review.checkId,
    now,
  });
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "elicitation",
    orderingKey: question.sessionId,
    idempotencyKey: `visual-review-continue:${asked.id}`,
    payload: {
      id: asked.id,
      sessionId: question.sessionId,
      questionId: asked.id,
      body: asked.body,
      options: [...VISUAL_REVIEW_CONTINUE_OPTIONS],
    },
    now,
  });
  return "asked";
}

export function visualReviewHandoff(db: Database, questionId: string): string | null {
  const review = getVisualReview(db, questionId);
  if (review === null) return null;
  if (review.outcome === "accepted") return visualReviewAcceptedHandoff(review.checkId);
  if (review.outcome === "changes_requested")
    return visualReviewChangesHandoff(
      review.checkId,
      review.feedback ?? "",
      markedFiles(db, review.itemId, questionId),
    );
  if (review.outcome === "continued") {
    const last = lastVisualReviewFeedback(db, review.itemId, review.checkId);
    const feedback = last?.feedback ?? "";
    return visualReviewChangesHandoff(
      review.checkId,
      review.feedback ? `${feedback}\n\n${review.feedback}` : feedback,
      last ? markedFiles(db, review.itemId, last.questionId) : [],
    );
  }
  return null;
}

function markedFiles(db: Database, itemId: string, questionId: string) {
  const evidence = new Map(listEvidence(db, itemId).map((row) => [row.id, row]));
  return listVisualReviewMarks(db, questionId).flatMap((mark) => {
    const row = evidence.get(mark.evidenceId);
    return row
      ? [
          {
            path: reviewMarkPath(mark.id),
            displayName: row.displayName,
            evidenceId: row.id,
            headCommit: row.headCommit,
          },
        ]
      : [];
  });
}

export function visualReviewApprovals(
  db: Database,
  itemId: string,
  task: string,
): EvidenceApproval[] {
  return acceptedVisualReviews(db, itemId).map((review) => ({
    task,
    checkId: review.checkId,
    evidenceIds: review.evidenceIds,
    approvedBy: review.answeredBy ?? "",
    approvedAt: new Date(review.answeredAt ?? review.createdAt).toISOString(),
    ...(review.headCommit ? { commit: review.headCommit } : {}),
  }));
}

export function visualReviewPullRequestNote(
  db: Database,
  item: WorkItemRecord,
  publicUrl: string | null,
  now: number = Date.now(),
): string {
  const accepted = listVisualReviews(db, item.id).filter((review) => review.outcome === "accepted");
  if (accepted.length === 0) return "";
  const evidence = listEvidence(db, item.id);
  const question = linearConversationUrl(db, item.sessionKey, item.linearIdentifier);
  const base = publicUrl?.replace(/\/+$/, "");
  const names = new Map(evidence.map((row) => [row.id, row.displayName]));
  return accepted
    .map((review) => {
      const full = carriedInFull(review);
      const origins = [
        ...new Map(review.carried.map((entry) => [entry.approvalId, entry])).values(),
      ];
      const carried = origins.map((origin) => {
        const screens = review.carried
          .filter((entry) => entry.approvalId === origin.approvalId)
          .map((entry) => names.get(entry.evidenceId) ?? entry.evidenceId);
        return `${full ? "Visual review carried over" : "Carried over"} from the approval by ${origin.approvedBy} at ${approvalTime(origin.approvedAt, now)} (approval ${origin.approvalId}), unchanged since: ${screens.join(", ")}.`;
      });
      return [
        ...(full
          ? []
          : [
              `Visual review accepted by ${review.answeredBy ?? "a reviewer"} in [Linear](<${question}>).`,
            ]),
        ...carried,
        ...latestEvidence(evidence.filter((row) => review.evidenceIds.includes(row.id))).flatMap(
          (row) => {
            const label = row.displayName.replace(/[\\[\]]/g, "\\$&");
            const url =
              row.assetUrl || (base ? `${base}/evidence/${encodeURIComponent(row.id)}` : null);
            if (!url) return [];
            return [
              `${row.assetUrl && row.mediaType.startsWith("image/") ? "!" : ""}[${label}](<${url}>)`,
            ];
          },
        ),
      ].join("\n\n");
    })
    .join("\n\n");
}

function reviewedHead(db: Database, itemId: string, review: StoredVisualReview): string | null {
  const shown = new Set(review.evidenceIds);
  const rows = listEvidence(db, itemId).filter((row) => shown.has(row.id));
  return rows.at(-1)?.headCommit ?? null;
}
