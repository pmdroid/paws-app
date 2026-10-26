import type { Database } from "bun:sqlite";
import { dropDeadElicitations, getWorkItem, immediate, journal } from "../db";
import { cancelQuestion, getQuestion, type StoredQuestion } from "../questions";
import { ask } from "./operations";

/**
 * A question whose elicitation died twice is asked again through {@link ask}, so the
 * person always has something to answer. The stale question is cancelled, the new one
 * gets its own id and so a fresh delivery, and the old dead rows leave the issue page.
 * Returns null and changes nothing when the item or the question has moved on.
 */
export function reaskDeadQuestion(
  db: Database,
  itemId: string,
  questionId: string,
  now: number,
): StoredQuestion | null {
  return immediate(db, () => {
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
    journal(`item ${item.id} question ${question.id} re-asked as ${asked.question.id}`);
    return asked.question;
  });
}
