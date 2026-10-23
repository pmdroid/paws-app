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
  linearConversationUrl,
  latestEvidence,
  listEvidence,
  listVisualReviewMarks,
  listVisualReviews,
  saveCheckpoint,
} from "../db";
import { reviewMarkPath } from "./input-files";
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
  },
): boolean {
  const { item, sessionId } = input;
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
  });
  applyWorkItemEvent(db, item.id, "blocking_question");
  saveCheckpoint(db, item.id, {
    phase: "awaiting_input",
    wipCommit: input.head,
    baseSha: input.base,
  });
  const base = input.publicUrl.replace(/\/+$/, "");
  const evidence = input.evidenceIds.map((id) => ({
    id,
    link: `${base}/evidence/${encodeURIComponent(id)}`,
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
      body: VISUAL_REVIEW_QUESTION,
      options: [...VISUAL_REVIEW_OPTIONS],
      evidence,
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
): string {
  const accepted = listVisualReviews(db, item.id).filter((review) => review.outcome === "accepted");
  if (accepted.length === 0) return "";
  const evidence = listEvidence(db, item.id);
  const question = linearConversationUrl(db, item.sessionKey, item.linearIdentifier);
  const base = publicUrl?.replace(/\/+$/, "");
  return accepted
    .map((review) =>
      [
        `Visual review accepted by ${review.answeredBy ?? "a reviewer"} in [Linear](<${question}>).`,
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
      ].join("\n\n"),
    )
    .join("\n\n");
}

function reviewedHead(db: Database, itemId: string, review: StoredVisualReview): string | null {
  const shown = new Set(review.evidenceIds);
  const rows = listEvidence(db, itemId).filter((row) => shown.has(row.id));
  return rows.at(-1)?.headCommit ?? null;
}
