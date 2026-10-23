import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { ResolvedEvidence } from "../closeout";
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
  findOpenQuestion,
  getQuestion,
  getVisualReview,
  openVisualReview,
  reviewedEvidenceIds,
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
