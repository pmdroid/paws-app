import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  announceLinearTurn,
  applyLinearTurns,
  applyWorkItemEvent,
  enqueueJobOnce,
  getWorkItem,
  listCloseoutRecoveries,
  saveCheckpoint,
} from "../db";
import { handoffNote, type AnswerEffects, type StoredQuestion } from "../questions";
import { askCloseoutHelp } from "./closeout-help";
import { parseRecoveryAnswer } from "./closeout-recovery";

const CLOSEOUT_HELP_RETRY =
  "Use /paws bypass check-id -- your reason from an identifiable trusted account, or reply with guidance.";

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
  const closeoutHelp = (question: StoredQuestion) => {
    const recovery = listCloseoutRecoveries(db, question.itemId).find(
      (entry) => entry.questionId === question.id,
    );
    if (recovery === undefined) return;
    const parsed = parseRecoveryAnswer(question.answer ?? "", recovery.failedChecks);
    if (parsed === null) {
      askCloseoutHelp(db, question.sessionId, recovery, {
        now: input.now,
        error: CLOSEOUT_HELP_RETRY,
      });
      return;
    }
    consumeTurn(question);
    applyWorkItemEvent(db, question.itemId, "answer_received");
    if (parsed.kind === "bypass") {
      applyWorkItemEvent(db, question.itemId, "turn_ended");
      saveCheckpoint(db, question.itemId, {
        phase: "verifying",
        baseSha: recovery.base,
        wipCommit: recovery.head,
      });
      enqueueJobOnce(db, {
        queue: JOB_KIND.reverify,
        jobKey: `closeout-bypass:${question.id}`,
        payload: { itemId: question.itemId },
        now: input.now,
      });
      return;
    }
    enqueueJobOnce(db, {
      queue: JOB_KIND.resume,
      jobKey: `closeout-guidance:${question.id}`,
      payload: {
        itemId: question.itemId,
        freshSession: true,
        handoff: handoffNote({ question: recovery.summary, answer: parsed.body }),
        reason: "closeout-guidance",
      },
      now: input.now,
    });
  };
  return {
    "runner-wait": consumeTurn,
    agent: resume,
    clarification: resume,
    repository: resume,
    "ci-help": resume,
    "closeout-help": closeoutHelp,
  };
}
