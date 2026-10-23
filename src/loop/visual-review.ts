import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EvidenceApproval, ResolvedEvidence } from "../closeout";
import { JOB_KIND } from "../core";
import {
  type WorkItemRecord,
  applyWorkItemEvent,
  enqueueJobOnce,
  enqueueOutboxOnce,
  getWorkItem,
  listEvidence,
  saveCheckpoint,
} from "../db";
import {
  acceptedVisualReviews,
  answerQuestion,
  findOpenQuestion,
  getQuestion,
  getVisualReview,
  lastVisualReviewFeedback,
  openVisualReview,
  openVisualReviewContinue,
  parseVisualReviewAnswer,
  recordVisualReviewAnswer,
  reviewedEvidenceIds,
  visualReviewAcceptedHandoff,
  visualReviewChangesHandoff,
  visualReviewRounds,
  VISUAL_REVIEW_CONTINUE_OPTIONS,
  VISUAL_REVIEW_ROUNDS,
  type StoredQuestion,
  type StoredVisualReview,
  visualReviewBody,
  VISUAL_REVIEW_OPTIONS,
  VISUAL_REVIEW_REMINDER,
  VISUAL_REVIEW_REMINDER_MS,
} from "../questions";

/**
 * After a file is published for an `approval: human` check, asks for a visual review once the
 * files not shown in an earlier review reach `minimum`. The question moves a running task to
 * `awaiting_input` and schedules one reminder. Returns `asked` when this call opened the review,
 * `waiting` when one is already open for the check, and null otherwise.
 */
export function askForVisualReview(
  db: Database,
  input: {
    item: WorkItemRecord;
    runId: string;
    sessionId: string;
    requirement: ResolvedEvidence;
    publicUrl: string;
    now: number;
  },
): "asked" | "waiting" | null {
  const { item, requirement, sessionId } = input;
  const open = findOpenQuestion(db, sessionId);
  if (open !== null)
    return getVisualReview(db, open.id)?.checkId === requirement.id ? "waiting" : null;
  const reviewed = reviewedEvidenceIds(db, item.id, requirement.id);
  const files = listEvidence(db, item.id).filter(
    (row) =>
      row.checkId === requirement.id &&
      !reviewed.has(row.id) &&
      requirement.media.includes(row.mediaType.startsWith("video/") ? "video" : "image"),
  );
  if (files.length < requirement.minimum) return null;
  const { question } = openVisualReview(db, {
    itemId: item.id,
    runId: input.runId,
    sessionId,
    checkId: requirement.id,
    evidenceIds: files.map((row) => row.id),
    now: input.now,
  });
  const current = getWorkItem(db, item.id);
  if (current?.state === "running") {
    applyWorkItemEvent(db, item.id, "blocking_question");
    saveCheckpoint(db, item.id, {
      phase: "awaiting_input",
      ...(current.checkpoint?.wipCommit ? { wipCommit: current.checkpoint.wipCommit } : {}),
      ...(current.checkpoint?.baseSha ? { baseSha: current.checkpoint.baseSha } : {}),
    });
  }
  const base = input.publicUrl.replace(/\/+$/, "");
  const evidence = files.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    link: `${base}/evidence/${encodeURIComponent(row.id)}`,
  }));
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "elicitation",
    orderingKey: sessionId,
    idempotencyKey: `visual-review:${question.id}`,
    payload: {
      id: question.id,
      sessionId,
      questionId: question.id,
      body: visualReviewBody(evidence),
      options: [...VISUAL_REVIEW_OPTIONS],
      evidence: evidence.map(({ id, link }) => ({ id, link })),
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
  return "asked";
}

/** Posts the one reminder while the review is still open and the task still waits on it. */
export function remindVisualReview(db: Database, questionId: string, now: number): boolean {
  const question = getQuestion(db, questionId);
  if (question === null || question.status !== "open" || !getVisualReview(db, questionId))
    return false;
  const item = getWorkItem(db, question.itemId);
  if (item === null || item.state !== "awaiting_input" || item.cancelRequested) return false;
  postNote(
    db,
    question.sessionId,
    item,
    VISUAL_REVIEW_REMINDER,
    `visual-review-reminder:${questionId}`,
    now,
  );
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
    const headCommit = item.checkpoint?.wipCommit ?? reviewedHead(db, item.id, review);
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
    return visualReviewChangesHandoff(review.checkId, review.feedback ?? "");
  if (review.outcome === "continued") {
    const feedback = lastVisualReviewFeedback(db, review.itemId, review.checkId) ?? "";
    return visualReviewChangesHandoff(
      review.checkId,
      review.feedback ? `${feedback}\n\n${review.feedback}` : feedback,
    );
  }
  return null;
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

function reviewedHead(db: Database, itemId: string, review: StoredVisualReview): string | null {
  const shown = new Set(review.evidenceIds);
  const rows = listEvidence(db, itemId).filter((row) => shown.has(row.id));
  return rows.at(-1)?.headCommit ?? null;
}
