import { ask, restart } from "./operations";
import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  applyLinearTurns,
  announceLinearTurn,
  applyWorkItemEvent,
  completePlanTask,
  enqueueJobOnce,
  enqueueOutboxOnce,
  extendAwakeCap,
  failWorkItem,
  getPlanProposal,
  getWorkItem,
  listCloseoutRecoveries,
  savePlanProposal,
  saveCheckpoint,
  saveVisualReviewMarks,
  type VisualReviewMark,
} from "../db";
import {
  findOpenQuestion,
  getVisualReview,
  handoffNote,
  type AnswerEffects,
  type StoredQuestion,
} from "../questions";
import { askCloseoutHelp } from "./closeout-help";
import { parseRecoveryAnswer } from "./closeout-recovery";
import {
  PLAN_DISCARDED,
  PLAN_EDIT_QUESTION,
  planDecision,
  planEditHandoff,
  planOptions,
} from "./plan-proposal";
import { worktreeBranch } from "./sources";
import { recordVisualReviewOutcome, visualReviewHandoff } from "./visual-review";

const CLOSEOUT_HELP_RETRY =
  "Use /paws bypass check-id -- your reason from an identifiable trusted account, or reply with guidance.";

export function questionEffects(
  db: Database,
  input: {
    now: number;
    asking?: (runId: string) => boolean;
    redirect?: boolean;
    marks?: readonly VisualReviewMark[];
  },
): AnswerEffects {
  const consumeTurn = (question: StoredQuestion) => {
    if (
      question.answerEventKey !== null &&
      getWorkItem(db, question.itemId)?.sessionKey === question.sessionId
    )
      applyLinearTurns(db, question.sessionId, [question.answerEventKey], question.itemId);
  };
  const restartWithAnswers = (question: StoredQuestion, body: string, jobKey: string) => {
    const item = getWorkItem(db, question.itemId);
    if (!item) return;
    const pending = db
      .query<
        { id: string; body: string; options: string | null; answer: string },
        [string, string]
      >(
        `SELECT id,body,options,answer FROM question WHERE item_id=? AND session_id=?
       AND status='answered' AND cancelled_at IS NULL AND handoff_version IS NULL
       AND kind NOT IN ('visual-review','runner-wait','github-auth') ORDER BY answered_at,rowid`,
      )
      .all(item.id, question.sessionId);
    const handoffs = pending.map((entry) =>
      entry.id === question.id
        ? body
        : handoffNote({
            question: entry.body,
            options: entry.options ? JSON.parse(entry.options) : [],
            answer: entry.answer,
          }),
    );
    const jobId = restart(db, item, {
      reason: "answer",
      body: handoffs.length ? handoffs.join("\n\n") : body,
      jobKey,
      now: input.now,
    });
    if (jobId !== null) {
      const version = getWorkItem(db, item.id)!.version;
      for (const entry of pending)
        db.run("UPDATE question SET handoff_version=? WHERE id=?", [version, entry.id]);
    }
  };
  const resume = (question: StoredQuestion) => {
    if (input.redirect && question.answerEventKey !== null)
      announceLinearTurn(db, question.sessionId, question.answerEventKey, input.now);
    else consumeTurn(question);
    if (findOpenQuestion(db, question.sessionId)?.itemId === question.itemId) return;
    restartWithAnswers(
      question,
      handoffNote({
        question: question.body,
        options: question.options,
        answer: question.answer ?? "",
      }),
      `resume:answer:${question.id}`,
    );
  };
  const closeoutHelp = (question: StoredQuestion) => {
    const recovery = listCloseoutRecoveries(db, question.itemId).find(
      (entry) => entry.questionId === question.id,
    );
    if (recovery === undefined) return;
    const parsed = parseRecoveryAnswer(question.answer ?? "", recovery.failedChecks);
    if (parsed === null) {
      db.run("UPDATE question SET handoff_version=0 WHERE id=?", [question.id]);
      askCloseoutHelp(db, question.sessionId, recovery, {
        now: input.now,
        error: CLOSEOUT_HELP_RETRY,
      });
      return;
    }
    consumeTurn(question);
    if (findOpenQuestion(db, question.sessionId)?.itemId === question.itemId) return;
    if (parsed.kind === "bypass") {
      db.run("UPDATE question SET handoff_version=0 WHERE id=?", [question.id]);
      applyWorkItemEvent(db, question.itemId, "answer_received");
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
    restartWithAnswers(
      question,
      handoffNote({ question: recovery.summary, answer: parsed.body }),
      `closeout-guidance:${question.id}`,
    );
  };
  /** Continue gives the resumed agent more awake time. Stop ends the task; the accepted work stays. */
  const timeLimit = (question: StoredQuestion) => {
    if (!/^\s*stop\b/i.test(question.answer ?? "")) {
      extendAwakeCap(db, question.itemId);
      resume(question);
      return;
    }
    consumeTurn(question);
    const item = applyWorkItemEvent(db, question.itemId, "answer_received");
    failWorkItem(
      db,
      item,
      "cap:time",
      `Stopped at the time limit, as asked in Linear. The accepted work is on branch \`${item.branchName || worktreeBranch(item)}\`.`,
      input.now,
    );
  };
  /**
   * Accept passes the pending-human check. While the other checks still run
   * on head S the item stays verifying and that evaluation picks the approval
   * up; once they are done, the evaluation of S completes from their results.
   * Request changes restarts the item with the feedback.
   */
  const visualReview = (question: StoredQuestion) => {
    const review = getVisualReview(db, question.id);
    if (review === null) return;
    if (input.marks) saveVisualReviewMarks(db, input.marks);
    const outcome = recordVisualReviewOutcome(db, question, review, input.now);
    if (!input.marks) consumeTurn(question);
    const item = getWorkItem(db, question.itemId);
    if (outcome === "asked" || !item) return;
    if (outcome === "changes") {
      restart(db, item, {
        reason: "review",
        body: visualReviewHandoff(db, question.id) ?? "",
        jobKey: `resume:answer:${question.id}`,
        now: input.now,
      });
      return;
    }
    if (item.state !== "awaiting_input" || findOpenQuestion(db, question.sessionId) !== null)
      return;
    applyWorkItemEvent(db, item.id, "answer_received");
    applyWorkItemEvent(db, item.id, "turn_ended");
    if (item.checkpoint) saveCheckpoint(db, item.id, { ...item.checkpoint, phase: "verifying" });
    enqueueJobOnce(db, {
      queue: JOB_KIND.reverify,
      jobKey: `visual-review-accepted:${question.id}`,
      payload: { itemId: item.id, decide: true },
      now: input.now,
    });
  };
  /**
   * Create completes the plan task and queues the filing, keyed on this
   * question so a redelivered answer files nothing twice. Discard completes it
   * with one response. A bare Edit asks what to change; any other reply is the
   * next planning turn.
   */
  const planApproval = (question: StoredQuestion) => {
    const proposal = getPlanProposal(db, question.id);
    const item = getWorkItem(db, question.itemId);
    if (proposal === null || item === null) return;
    consumeTurn(question);
    if (item.state !== "awaiting_input" || item.cancelRequested) return;
    if (findOpenQuestion(db, question.sessionId)?.itemId === question.itemId) return;
    const answer = question.answer ?? "";
    const decision = planDecision(answer, proposal.drafts.length);
    db.run("UPDATE question SET handoff_version=0 WHERE id=?", [question.id]);
    if (decision === "edit-ask") {
      const asked = ask(
        db,
        { itemId: item.id, runId: null, sessionId: question.sessionId, version: item.version },
        "plan-approval",
        PLAN_EDIT_QUESTION,
        { options: planOptions(proposal.drafts.length), now: input.now },
      );
      savePlanProposal(db, { ...proposal, questionId: asked.question.id, now: input.now });
      return;
    }
    if (decision === "edit") {
      restart(db, item, {
        reason: "answer",
        body: planEditHandoff(proposal.drafts, answer),
        jobKey: `plan-edit:${question.id}`,
        now: input.now,
      });
      return;
    }
    completePlanTask(db, item.id, input.now);
    if (decision === "discard")
      enqueueOutboxOnce(db, {
        target: "linear",
        op: "activity",
        orderingKey: question.sessionId,
        idempotencyKey: `plan-discarded:${question.id}`,
        payload: { sessionId: question.sessionId, kind: "response", body: PLAN_DISCARDED },
        now: input.now,
      });
    else
      enqueueOutboxOnce(db, {
        target: "linear",
        op: "linear.sub_issues",
        orderingKey: question.sessionId,
        idempotencyKey: `plan-create:${question.id}`,
        payload: {
          questionId: question.id,
          itemId: item.id,
          sessionId: question.sessionId,
          issueId: proposal.parentIssueId,
          identifier: item.linearIdentifier,
        },
        now: input.now,
      });
  };
  return {
    "plan-approval": planApproval,
    "visual-review": visualReview,
    "runner-wait": (question) => {
      consumeTurn(question);
      if (findOpenQuestion(db, question.sessionId)?.itemId === question.itemId) return;
      const item = getWorkItem(db, question.itemId);
      if (item?.state !== "awaiting_input") return;
      applyWorkItemEvent(db, item.id, "answer_received");
      applyWorkItemEvent(db, item.id, "turn_ended");
      const live = db
        .query(
          "SELECT 1 FROM job WHERE status='running' AND locked_until>? AND json_extract(payload,'$.itemId')=?",
        )
        .get(input.now, item.id);
      if (!live)
        enqueueJobOnce(db, {
          queue: JOB_KIND.reverify,
          jobKey: `runner-wait:${question.id}`,
          payload: { itemId: item.id },
          now: input.now,
        });
    },
    "time-limit": timeLimit,
    agent: resume,
    clarification: resume,
    repository: resume,
    "ci-help": resume,
    "closeout-help": closeoutHelp,
  };
}
