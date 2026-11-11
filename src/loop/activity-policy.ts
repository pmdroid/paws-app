import {
  pullRequestReadyQueuedSteps,
  sessionHasFinalResponseSteps,
  sessionPullRequestOpenSteps,
  type Q,
  type Steps,
} from "../db";

/**
 * Responses that may follow the PR response: the final merged, closed or stopped line, a
 * comment-only GitHub review's threads, posted once per review id, what a person decided on
 * the risk approval, the record of a question answered in Paws, and the merge queue's review
 * wait, once per generation, head and reason (`merge-review:`), and the wait behind another item
 * after a conflict, once per generation and blocker (`merge-hold:`). The PR response of a later
 * generation, once per generation, completes the session a person's message reopened. A response
 * keeps the session complete, so none reopens it.
 */
export const AFTER_PULL_REQUEST_RESPONSE =
  /^(pull-request-ready:|merged:|closed:|command:stop:|pull-review:|risk-approval:|paws-answer:|merge-review:|merge-hold:|reply:)/;

/**
 * Thoughts that may follow the PR response: a change request on the risk approval, from the
 * Risk card or a Linear reply, and a review or comments on the pull request that sent the item
 * back to the agent (`pull-feedback:`), and a conflict with main that sent it back to rebase
 * (`merge-conflict:`). Each wakes the session, so a person sees the agent work. The
 * acknowledgement of a person's message in the session (`turn:ack:`, and the `fresh-budget:` line
 * of the turn it starts) answers them, so it passes too.
 */
export const AFTER_PULL_REQUEST_THOUGHT =
  /^(risk-approval:|pull-feedback:|merge-conflict:|turn:ack:|fresh-budget:)/;

export function* hasPublishedPullRequestSteps(
  q: Q,
  sessionId: string,
  generation: number,
): Steps<boolean> {
  return (
    (yield* pullRequestReadyQueuedSteps(q, sessionId, generation)) ||
    (yield* sessionPullRequestOpenSteps(q, sessionId, generation))
  );
}

export function* canReportProgressSteps(
  q: Q,
  sessionId: string,
  generation: number,
  rowId?: number,
): Steps<boolean> {
  return (
    !(yield* sessionHasFinalResponseSteps(q, sessionId, generation, rowId)) &&
    !(yield* sessionPullRequestOpenSteps(q, sessionId, generation, rowId))
  );
}
