import { mergeAcceptedWorkSteps } from "./accepted-work";
import { SLOW_CI_REASON } from "./merge-jobs";
import { askSteps, restartSteps } from "./operations";
import {
  JOB_KIND,
  TIME_LIMIT_CONTINUE,
  TIME_LIMIT_MERGE,
  TIME_LIMIT_VERIFYING_REASON,
  type StageLimits,
} from "../core";
import { startFreshBudgetSteps } from "./time-budget";
import {
  agentTurnStageSteps,
  announceLinearTurnSteps,
  applyLinearTurnsSteps,
  applyWorkItemEventSteps,
  completePlanTaskSteps,
  enqueueJobOnceSteps,
  enqueueOutboxOnceSteps,
  failWorkItemSteps,
  getPlanProposalSteps,
  getWorkItemSteps,
  hasLiveJobSteps,
  heldHandoffsSteps,
  listCloseoutRecoveriesSteps,
  markHandoffsCarriedSteps,
  pendingAnswerHandoffsSteps,
  saveCheckpointSteps,
  savePlanProposalSteps,
  saveVisualReviewMarksSteps,
  setQuestionHandoffVersionSteps,
  setRetryAnswerSteps,
  commandInstance,
  type HeldHandoff,
  type Q,
  type Steps,
  type VisualReviewMark,
  type Db,
} from "../db";
import {
  findOpenQuestionSteps,
  getVisualReviewSteps,
  handoffNote,
  type AnswerEffects,
  type StoredQuestion,
} from "../questions";
import {
  PLAN_DISCARDED,
  PLAN_EDIT_QUESTION,
  planDecision,
  planEditHandoff,
  planOptions,
} from "./plan-proposal";
import { RETRY_CLOSEOUT, retriesCloseout } from "./closeout-recovery";
import { retriesMerge } from "../merge";
import { worktreeBranch } from "./sources";
import { answerRunnerRepositorySteps } from "./runner-repository";
import { recordVisualReviewOutcomeSteps, visualReviewHandoffSteps } from "./visual-review";

function* consumeTurnSteps(q: Q, question: StoredQuestion): Steps<void> {
  if (
    question.answerEventKey !== null &&
    (yield* getWorkItemSteps(q, question.itemId))?.sessionKey === question.sessionId
  )
    yield* applyLinearTurnsSteps(q, question.sessionId, [question.answerEventKey], question.itemId);
}

type VerifyInput = { now: number; key?: string };

export function* verifyAgainSteps(q: Q, question: StoredQuestion, input: VerifyInput) {
  yield* consumeTurnSteps(q, question);
  if ((yield* findOpenQuestionSteps(q, question.sessionId))?.itemId === question.itemId) return;
  const item = yield* getWorkItemSteps(q, question.itemId);
  if (item?.state !== "awaiting_input") return;
  yield* applyWorkItemEventSteps(q, item.id, "reverify_requested", { now: input.now });
  if (item.checkpoint)
    yield* saveCheckpointSteps(q, item.id, { ...item.checkpoint, phase: "verifying" });
  yield* enqueueJobOnceSteps(q, {
    queue: JOB_KIND.reverify,
    jobKey: `${input.key ?? "time-limit"}:${question.id}`,
    payload: { itemId: item.id },
    now: input.now,
  });
}

type RetryInput = { now: number; answer?: string };

export function* retryCloseoutSteps(q: Q, question: StoredQuestion, input: RetryInput) {
  yield* setRetryAnswerSteps(q, question.id, input.answer ?? RETRY_CLOSEOUT);
  yield* verifyAgainSteps(q, question, { now: input.now, key: "retry-closeout" });
}

export function questionEffects(
  store: Db,
  input: {
    now: number;
    maxAwakeMs?: number | undefined;
    timeLimits?: ((projectId: string | null) => StageLimits) | undefined;
    asking?: (runId: string) => boolean;
    redirect?: boolean;
    marks?: readonly VisualReviewMark[];
  },
): AnswerEffects {
  const consumeTurn = (q: Q, question: StoredQuestion) => consumeTurnSteps(q, question);
  function* restartWithAnswers(
    q: Q,
    question: StoredQuestion,
    body: string,
    jobKey: string,
    /** Handoffs the time limit held back, handed over before the answers. */
    held: readonly HeldHandoff[] = [],
  ): Steps<void> {
    const item = yield* getWorkItemSteps(q, question.itemId);
    if (!item) return;
    const pending = yield* pendingAnswerHandoffsSteps(q, item.id, question.sessionId, [
      "visual-review",
      "runner-wait",
      "runner-repository",
      "github-auth",
      "link",
      "push-outage",
      "policy-outage",
    ]);
    const handoffs = pending.map((entry) =>
      entry.id === question.id
        ? body
        : handoffNote({
            question: entry.body,
            options: entry.options ? JSON.parse(entry.options) : [],
            answer: entry.answer ?? "",
          }),
    );
    const answers = handoffs.length ? handoffs : [body];
    const restarted = yield* restartSteps(q, item, {
      reason: "answer",
      body: [...held.map((entry) => entry.handoff), ...answers].join("\n\n"),
      jobKey,
      now: input.now,
    });
    if (restarted !== null) {
      yield* markHandoffsCarriedSteps(q, held);
      const version = (yield* getWorkItemSteps(q, item.id))!.version;
      for (const entry of pending) yield* setQuestionHandoffVersionSteps(q, entry.id, version);
    }
  }
  function* resume(q: Q, question: StoredQuestion, held: readonly HeldHandoff[] = []) {
    if (input.redirect && question.answerEventKey !== null)
      yield* announceLinearTurnSteps(q, question.sessionId, question.answerEventKey, input.now);
    else yield* consumeTurn(q, question);
    if ((yield* findOpenQuestionSteps(q, question.sessionId))?.itemId === question.itemId) return;
    yield* restartWithAnswers(
      q,
      question,
      handoffNote({
        question: question.body,
        options: question.options,
        answer: question.answer ?? "",
      }),
      `resume:answer:${question.id}`,
      held,
    );
  }
  /** A reply is guidance for the agent. It never bypasses a check: that is decided on the item page. */
  function* closeoutHelp(q: Q, question: StoredQuestion): Steps<void> {
    const recovery = (yield* listCloseoutRecoveriesSteps(q, question.itemId)).find(
      (entry) => entry.questionId === question.id,
    );
    if (recovery === undefined) return;
    if (retriesCloseout(question)) {
      yield* retryCloseoutSteps(q, question, { now: input.now });
      return;
    }
    yield* consumeTurn(q, question);
    if ((yield* findOpenQuestionSteps(q, question.sessionId))?.itemId === question.itemId) return;
    yield* restartWithAnswers(
      q,
      question,
      handoffNote({ question: recovery.summary, answer: question.answer ?? "" }),
      `closeout-guidance:${question.id}`,
    );
  }
  function* mergeHelp(q: Q, question: StoredQuestion): Steps<void> {
    if (!retriesMerge(question)) {
      yield* resume(q, question);
      return;
    }
    yield* consumeTurn(q, question);
    if ((yield* findOpenQuestionSteps(q, question.sessionId))?.itemId === question.itemId) return;
    yield* mergeAcceptedWorkSteps(q, question.itemId, { now: input.now });
  }
  /**
   * Merge sends the accepted head to the merge queue without another turn. Continue, or a typed
   * reply, resumes the agent, or a stopped Closeout run, with a fresh budget. Stop ends the task;
   * the work stays.
   */
  function* timeLimit(q: Q, question: StoredQuestion): Steps<void> {
    if ((question.answer ?? "").trim().toLowerCase() === TIME_LIMIT_MERGE.toLowerCase()) {
      yield* consumeTurn(q, question);
      yield* mergeAcceptedWorkSteps(q, question.itemId, { now: input.now });
      return;
    }
    if (!/^\s*stop\b/i.test(question.answer ?? "")) {
      const plain =
        (question.answer ?? "").trim().toLowerCase() === TIME_LIMIT_CONTINUE.toLowerCase();
      const item = yield* getWorkItemSteps(q, question.itemId);
      yield* startFreshBudgetSteps(q, {
        itemId: question.itemId,
        sessionId: question.sessionId,
        key: question.id,
        maxAwakeMs: input.maxAwakeMs,
        limits: item ? input.timeLimits?.(item.linearProjectId ?? null) : undefined,
        stage:
          question.reason === SLOW_CI_REASON
            ? undefined
            : question.reason === TIME_LIMIT_VERIFYING_REASON
              ? "closeout"
              : yield* agentTurnStageSteps(q, question.itemId),
        now: input.now,
      });
      // A review or comment restart the time limit cut off reaches the agent with the answer.
      const held = yield* heldHandoffsSteps(q, question.itemId);
      if (plain && held.length === 0 && question.reason === TIME_LIMIT_VERIFYING_REASON)
        yield* verifyAgainSteps(q, question, { now: input.now });
      else yield* resume(q, question, held);
      return;
    }
    yield* consumeTurn(q, question);
    const item = yield* getWorkItemSteps(q, question.itemId);
    if (item?.state !== "awaiting_input") return;
    yield* failWorkItemSteps(
      q,
      item,
      question.reason === SLOW_CI_REASON ? "merge" : "cap:time",
      `${question.reason === SLOW_CI_REASON ? "Stopped while GitHub CI was pending" : "Stopped at the time limit"}, as asked in Linear. The ${item.acceptedHead === null ? "work" : "accepted work"} is on branch \`${item.branchName || worktreeBranch(item)}\`.`,
      input.now,
      { stoppedByAnswer: true },
    );
  }
  /**
   * A Linear answer to a review question asked before the link ask. It never
   * approves: it restarts the item with the feedback, or asks whether to keep
   * going after the round limit. Screens are approved only on the item page.
   */
  function* visualReview(q: Q, question: StoredQuestion): Steps<void> {
    const review = yield* getVisualReviewSteps(q, question.id);
    if (review === null) return;
    if (input.marks) yield* saveVisualReviewMarksSteps(q, input.marks);
    const outcome = yield* recordVisualReviewOutcomeSteps(q, question, review, input.now);
    if (!input.marks) yield* consumeTurn(q, question);
    const item = yield* getWorkItemSteps(q, question.itemId);
    if (outcome === "asked" || !item) return;
    yield* restartSteps(q, item, {
      reason: "review",
      body: (yield* visualReviewHandoffSteps(q, question.id)) ?? "",
      jobKey: `resume:answer:${question.id}`,
      now: input.now,
    });
  }
  /**
   * Create completes the plan task and queues the filing, keyed on this
   * question so a redelivered answer files nothing twice. Discard completes it
   * with one response. A bare Edit asks what to change; any other reply is the
   * next planning turn.
   */
  function* planApproval(q: Q, question: StoredQuestion): Steps<void> {
    const proposal = yield* getPlanProposalSteps(q, question.id);
    const item = yield* getWorkItemSteps(q, question.itemId);
    if (proposal === null || item === null) return;
    yield* consumeTurn(q, question);
    if (item.state !== "awaiting_input" || item.cancelRequested) return;
    if ((yield* findOpenQuestionSteps(q, question.sessionId))?.itemId === question.itemId) return;
    const answer = question.answer ?? "";
    const decision = planDecision(answer, proposal.drafts.length);
    yield* setQuestionHandoffVersionSteps(q, question.id, 0);
    if (decision === "edit-ask") {
      const asked = yield* askSteps(
        q,
        { itemId: item.id, runId: null, sessionId: question.sessionId, version: item.version },
        "plan-approval",
        PLAN_EDIT_QUESTION,
        { options: planOptions(proposal.drafts.length), now: input.now },
      );
      yield* savePlanProposalSteps(q, {
        ...proposal,
        questionId: asked.question.id,
        now: input.now,
      });
      return;
    }
    if (decision === "edit") {
      yield* restartSteps(q, item, {
        reason: "answer",
        body: planEditHandoff(proposal.drafts, answer),
        jobKey: `plan-edit:${question.id}`,
        now: input.now,
      });
      return;
    }
    yield* completePlanTaskSteps(q, item.id, input.now);
    if (decision === "discard")
      yield* enqueueOutboxOnceSteps(q, {
        target: "linear",
        op: "activity",
        orderingKey: question.sessionId,
        idempotencyKey: `plan-discarded:${question.id}`,
        payload: { sessionId: question.sessionId, kind: "response", body: PLAN_DISCARDED },
        now: input.now,
      });
    else
      yield* enqueueOutboxOnceSteps(q, {
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
  }
  return {
    "plan-approval": planApproval,
    "visual-review": visualReview,
    "runner-wait": function* (q, question) {
      yield* consumeTurn(q, question);
      if ((yield* findOpenQuestionSteps(q, question.sessionId))?.itemId === question.itemId) return;
      const item = yield* getWorkItemSteps(q, question.itemId);
      if (item?.state !== "awaiting_input") return;
      yield* applyWorkItemEventSteps(q, item.id, "reverify_requested", { now: input.now });
      if (!(yield* hasLiveJobSteps(q, item.id, input.now)))
        yield* enqueueJobOnceSteps(q, {
          queue: JOB_KIND.reverify,
          jobKey: `runner-wait:${question.id}`,
          payload: { itemId: item.id },
          now: input.now,
        });
    },
    "time-limit": timeLimit,
    "runner-repository": function* (q, question) {
      yield* consumeTurn(q, question);
      yield* answerRunnerRepositorySteps(q, question, input.now, commandInstance(store), {
        ready: false,
      });
    },
    agent: resume,
    clarification: resume,
    repository: resume,
    "ci-help": mergeHelp,
    "closeout-help": closeoutHelp,
    // The workspace push outage question asks a person to look at GitHub; the item goes on.
    "push-outage": consumeTurn,
    "policy-outage": consumeTurn,
  };
}
