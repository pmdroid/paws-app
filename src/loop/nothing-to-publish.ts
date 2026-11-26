import {
  applyWorkItemEventSteps,
  cancelAdvancingJobsSteps,
  enqueueIssueStatusSteps,
  enqueueOutboxOnceSteps,
  getWorkItemSteps,
  markRunSteps,
  type Q,
  type Steps,
} from "../db";
import type { StoredQuestion } from "../questions";

export const NOTHING_TO_PUBLISH_REASON = "nothing_to_publish";
export const COMPLETE_WITHOUT_PULL = "Complete without a pull request";
export const NOTHING_TO_PUBLISH_OPTIONS = [COMPLETE_WITHOUT_PULL, "Send back to the agent"];

export function nothingToPublishQuestion(branch: string): string {
  return `Branch \`${branch}\` has no commits ahead of main, so there is no pull request to open. Complete without a pull request, or send back to the agent?`;
}

export function completesWithoutPull(question: Pick<StoredQuestion, "answer">): boolean {
  const answer = (question.answer ?? "").trim().toLowerCase();
  return answer === COMPLETE_WITHOUT_PULL.toLowerCase() || answer === "complete";
}

export function* completeWithoutPullSteps(q: Q, itemId: string, now: number): Steps<void> {
  const item = yield* getWorkItemSteps(q, itemId);
  if (!item || item.state !== "awaiting_input" || item.cancelRequested) return;
  yield* applyWorkItemEventSteps(q, itemId, "answer_completed", { now });
  if (item.currentRunId) yield* markRunSteps(q, item.currentRunId, "ended", now);
  yield* cancelAdvancingJobsSteps(q, itemId, "completed_without_pull", now);
  if (item.sessionKey)
    yield* enqueueOutboxOnceSteps(q, {
      target: "linear",
      op: "activity",
      orderingKey: item.sessionKey,
      idempotencyKey: `completed-without-pull:${itemId}`,
      payload: {
        sessionId: item.sessionKey,
        itemId,
        kind: "response",
        body: `Completed without a pull request, as asked: branch \`${item.branchName}\` has no commits ahead of main.`,
      },
      now,
    });
  yield* enqueueIssueStatusSteps(q, (yield* getWorkItemSteps(q, itemId))!, "completed", now);
}
