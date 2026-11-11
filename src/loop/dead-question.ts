import {
  dropDeadElicitationsSteps,
  getWorkItemSteps,
  journal,
  questionHasLinkedRecordsSteps,
  recordQuestionReaskSteps,
  redeliverQuestionSteps,
  type Db,
} from "../db";
import { cancelQuestionSteps, getQuestionSteps } from "../questions";
import { askSteps } from "./operations";

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
export async function reaskDeadQuestion(
  store: Db,
  input: { itemId: string; questionId: string; jobId: number; now: number },
): Promise<string | null> {
  return await store.transaction(function* (q) {
    const { itemId, questionId, jobId, now } = input;
    const item = yield* getWorkItemSteps(q, itemId);
    const question = yield* getQuestionSteps(q, questionId);
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
    if (yield* questionHasLinkedRecordsSteps(q, question.id)) {
      if ((yield* redeliverQuestionSteps(q, question.id, now)) === null) return null;
      yield* recordQuestionReaskSteps(q, jobId, question.id);
      return question.id;
    }
    yield* cancelQuestionSteps(q, question.id, now);
    const asked = yield* askSteps(
      q,
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
    yield* dropDeadElicitationsSteps(q, question.id, `Re-asked as question ${asked.question.id}.`);
    yield* recordQuestionReaskSteps(q, jobId, asked.question.id);
    journal(`item ${item.id} question ${question.id} re-asked as ${asked.question.id}`);
    return asked.question.id;
  });
}
