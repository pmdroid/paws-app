import { JOB_KIND } from "../core";
import {
  applyWorkItemEventSteps,
  cancelAdvancingJobsSteps,
  enqueueIssueStatusSteps,
  enqueueJobOnceSteps,
  enqueueOutboxOnceSteps,
  getItemPullRequestSteps,
  getWorkItemSteps,
  markRunSteps,
  type Q,
  type Steps,
} from "../db";
import type { StoredQuestion } from "../questions";

export const NOTHING_TO_PUBLISH_REASON = "nothing_to_publish";
export const COMPLETE_WITHOUT_PULL = "Complete without a pull request";
export const NOTHING_TO_PUBLISH_OPTIONS = [COMPLETE_WITHOUT_PULL, "Send back to the agent"];
export const CLOSE_PULL_AND_COMPLETE = "Close the pull request and complete";
export const KEEP_PULL_AND_MERGE = "Keep the pull request and merge";
export const UNCHANGED_PULL_OPTIONS = [CLOSE_PULL_AND_COMPLETE, KEEP_PULL_AND_MERGE];

export function nothingToPublishQuestion(branch: string): string {
  return `Branch \`${branch}\` has no commits ahead of main, so there is no pull request to open. Complete without a pull request, or send back to the agent?`;
}

export function unchangedPullQuestion(branch: string, pullNumber: number): string {
  return `The agent ended without changing branch \`${branch}\` and says no change is needed, but PR #${pullNumber} is still open. Close the pull request and complete, or keep the pull request and merge?`;
}

const NO_CHANGE_NEEDED =
  /\bneeds? no (?:code )?changes?\b|\bno (?:code )?changes? (?:is |are )?(?:needed|required|necessary)\b|\bnothing to change\b/i;

export function saysNoChangeNeeded(finalMessage: string): boolean {
  return NO_CHANGE_NEEDED.test(finalMessage);
}

export function completesWithoutPull(question: Pick<StoredQuestion, "answer">): boolean {
  const answer = (question.answer ?? "").trim().toLowerCase();
  return (
    answer === COMPLETE_WITHOUT_PULL.toLowerCase() ||
    answer === CLOSE_PULL_AND_COMPLETE.toLowerCase() ||
    answer === "complete"
  );
}

export function keepsPull(question: Pick<StoredQuestion, "answer">): boolean {
  return (question.answer ?? "").trim().toLowerCase() === KEEP_PULL_AND_MERGE.toLowerCase();
}

export function* completeWithoutPullSteps(q: Q, itemId: string, now: number): Steps<void> {
  const item = yield* getWorkItemSteps(q, itemId);
  if (!item || item.state !== "awaiting_input" || item.cancelRequested) return;
  const pull = yield* getItemPullRequestSteps(q, itemId);
  yield* applyWorkItemEventSteps(q, itemId, "answer_completed", { now });
  if (item.currentRunId) yield* markRunSteps(q, item.currentRunId, "ended", now);
  yield* cancelAdvancingJobsSteps(q, itemId, "completed_without_pull", now);
  if (pull)
    yield* enqueueJobOnceSteps(q, {
      queue: JOB_KIND.closeStoppedPull,
      jobKey: `close-completed:${itemId}`,
      payload: {
        itemId,
        completed: true,
        comment: `Closed without merging, as asked in Linear: ${item.linearIdentifier} needs no change.`,
      },
      now,
    });
  if (item.sessionKey)
    yield* enqueueOutboxOnceSteps(q, {
      target: "linear",
      op: "activity",
      orderingKey: item.sessionKey,
      idempotencyKey: `${pull ? "closed:completed" : "completed-without-pull"}:${itemId}`,
      payload: {
        sessionId: item.sessionKey,
        itemId,
        kind: "response",
        body: pull
          ? `Completed without merging, as asked: PR #${pull.pullNumber} is closed and branch \`${item.branchName}\` is deleted.`
          : `Completed without a pull request, as asked: branch \`${item.branchName}\` has no commits ahead of main.`,
      },
      now,
    });
  yield* enqueueIssueStatusSteps(q, (yield* getWorkItemSteps(q, itemId))!, "completed", now);
}
