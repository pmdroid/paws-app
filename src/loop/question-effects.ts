import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  announceLinearTurn,
  applyLinearTurns,
  applyWorkItemEvent,
  enqueueJobOnce,
  getWorkItem,
} from "../db";
import { handoffNote, type AnswerEffects, type StoredQuestion } from "../questions";

export function questionEffects(
  db: Database,
  input: { now: number; asking?: (runId: string) => boolean; redirect?: boolean },
): AnswerEffects {
  const consumeTurn = (question: StoredQuestion) => {
    if (
      question.answerEventKey !== null &&
      getWorkItem(db, question.itemId)?.sessionKey === question.sessionId
    )
      applyLinearTurns(db, question.sessionId, [question.answerEventKey], question.itemId);
  };
  const resume = (question: StoredQuestion) => {
    applyWorkItemEvent(db, question.itemId, "answer_received");
    if (input.redirect) {
      if (question.answerEventKey !== null)
        announceLinearTurn(db, question.sessionId, question.answerEventKey, input.now);
      return;
    }
    consumeTurn(question);
    if (question.runId !== null && input.asking?.(question.runId)) return;
    enqueueJobOnce(db, {
      queue: JOB_KIND.resume,
      jobKey: `resume:answer:${question.id}`,
      payload: {
        itemId: question.itemId,
        freshSession: true,
        handoff: handoffNote({
          question: question.body,
          options: question.options,
          answer: question.answer ?? "",
        }),
        reason: "answer",
      },
      now: input.now,
    });
  };
  return {
    "runner-wait": consumeTurn,
    agent: resume,
    clarification: resume,
    repository: resume,
  };
}
