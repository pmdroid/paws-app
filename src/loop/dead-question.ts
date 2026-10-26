import type { Database } from "bun:sqlite";
import {
  dropDeadElicitations,
  getWorkItem,
  immediate,
  journal,
  questionHasLinkedRecords,
  recordQuestionReask,
  redeliverQuestion,
} from "../db";
import { cancelQuestion, getQuestion } from "../questions";
import { ask } from "./operations";

/**
 * A question whose elicitation died twice is asked again, so the person always has
 * something to answer.
 *
 * A plain question goes through {@link ask}: the stale one is cancelled and the new one
 * gets its own id and so a fresh delivery. A question that other records are tied to by id
 * (a visual review, a Closeout recovery, a repository choice, a decision, a GitHub hold)
 * keeps its id, because its answer is read through those records; it is delivered again.
 *
 * `jobId` is the re-ask job; it records the question it produced, so that question's death
 * counts against the same allowance. Returns the question id now waiting for an answer,
 * or null when the item or the question has moved on.
 */
export function reaskDeadQuestion(
  db: Database,
  input: { itemId: string; questionId: string; jobId: number; now: number },
): string | null {
  return immediate(db, () => {
    const { itemId, questionId, jobId, now } = input;
    const item = getWorkItem(db, itemId);
    const question = getQuestion(db, questionId);
    if (
      item === null ||
      question === null ||
      item.state !== "awaiting_input" ||
      item.cancelRequested ||
      item.sessionKey === null ||
      question.itemId !== item.id ||
      question.sessionId !== item.sessionKey ||
      question.status !== "open" ||
      question.cancelledAt !== null
    )
      return null;
    if (questionHasLinkedRecords(db, question.id)) {
      if (redeliverQuestion(db, question.id, now) === null) return null;
      recordQuestionReask(db, jobId, question.id);
      return question.id;
    }
    cancelQuestion(db, question.id, now);
    const asked = ask(
      db,
      {
        itemId: item.id,
        runId: item.currentRunId,
        sessionId: item.sessionKey,
        version: item.version,
      },
      question.kind,
      question.body,
      {
        options: question.options,
        ...(question.context === null ? {} : { context: question.context }),
        reason: question.reason,
        now,
      },
    );
    dropDeadElicitations(db, question.id, `Re-asked as question ${asked.question.id}.`);
    recordQuestionReask(db, jobId, asked.question.id);
    journal(`item ${item.id} question ${question.id} re-asked as ${asked.question.id}`);
    return asked.question.id;
  });
}
