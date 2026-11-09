import { pullRequestReadyQueued, sessionHasFinalResponse } from "../db";
import type { Database } from "bun:sqlite";

/**
 * Responses that may follow the PR response: the final merged, closed or stopped line, a
 * comment-only GitHub review's threads, posted once per review id, what a person decided on
 * the risk approval, the record of a question answered in Paws, and the merge queue's review
 * wait, once per generation, head and reason (`merge-review:`). A response keeps the session
 * complete, so none reopens it.
 */
export const AFTER_PULL_REQUEST_RESPONSE =
  /^(merged:|closed:|command:stop:|pull-review:|risk-approval:|paws-answer:|merge-review:|reply:|conversation:)/;

/**
 * Thoughts that may follow the PR response: a change request on the risk approval, from the
 * Risk card or a Linear reply, and a review or comments on the pull request that sent the item
 * back to the agent (`pull-feedback:`). Each wakes the session, so a person sees the agent work.
 */
export const AFTER_PULL_REQUEST_THOUGHT = /^(risk-approval:|pull-feedback:)/;

/** The PR response completes this generation; only a terminal response or ask may follow. */
export function hasPublishedPullRequest(
  db: Database,
  sessionId: string,
  generation: number,
): boolean {
  return pullRequestReadyQueued(db, sessionId, generation);
}

export function canReportProgress(
  db: Database,
  sessionId: string,
  generation: number,
  rowId?: number,
): boolean {
  return !sessionHasFinalResponse(db, sessionId, generation, rowId);
}
