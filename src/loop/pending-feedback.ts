import type { Database } from "bun:sqlite";
import type { StoredReviewFinding } from "../closeout";
import {
  fixRounds,
  getItemPullRequest,
  getItemPullRequestSteps,
  getPullReview,
  pendingChangeRequests,
  pendingPullCiFailuresSteps,
  pendingPullComments,
  pendingPullCommentsSteps,
  recordReviewEscape,
  settlePullComments,
  sqliteDb,
  type NewReviewReply,
  type RestartHandoff,
  type PullCiFailureRecord,
  type PullCommentRecord,
  type WorkItemRecord,
} from "../db";
import type { ReviewThread } from "../github";
import { REBASE_CONFLICT_INSTRUCTION } from "../merge";
import { restart } from "./operations";
import { COMMENT_FIX_INSTRUCTION, commentDigest } from "./pull-comments";
import { currentPullCi, pullCiHandoff, pullCiHead, pullCiRestarted } from "./pull-ci";
import {
  closeoutFindingsNote,
  postPullFeedback,
  type PullReviewCapabilities,
} from "./pull-reviews";
import { recordReplyTargets, replyListSection, replyTargets } from "./review-replies";

export const REBASED_LINES_NOTE =
  "The comments below were made before this rebase. Their line numbers refer to the commit each comment was made on and may have moved after the rebase: find the code they mean on the rebased branch.";

export type FeedbackReads = {
  pullNumber: number;
  threads: readonly ReviewThread[];
  findings: readonly StoredReviewFinding[];
  head: string | null;
  started: number;
};

export type FeedbackCapabilities = Pick<
  PullReviewCapabilities,
  "now" | "threads" | "closeoutFindings" | "pullHead"
>;

export type PendingFeedback = {
  pullNumber: number;
  comments: readonly PullCommentRecord[];
  digest: string | null;
  failure: PullCiFailureRecord | null;
  targets: NewReviewReply[];
  findings: readonly StoredReviewFinding[];
};

export async function readPendingFeedback(
  db: Database,
  item: WorkItemRecord,
  caps: FeedbackCapabilities,
): Promise<FeedbackReads | null> {
  const store = sqliteDb(db);
  const started = caps.now();
  const open = await store.run((q) => pendingPullCommentsSteps(q, item.id));
  if (
    open.length === 0 &&
    (await store.run((q) => pendingPullCiFailuresSteps(q, item.id))).length === 0
  )
    return null;
  const pullNumber =
    (await store.run((q) => getItemPullRequestSteps(q, item.id)))?.pullNumber ??
    open.at(-1)?.pullNumber;
  if (pullNumber === undefined) return null;
  const threads =
    open.length > 0 ? await caps.threads(item, pullNumber).catch((): ReviewThread[] => []) : [];
  const findings = open.length > 0 ? await caps.closeoutFindings(item) : [];
  const head = await pullCiHead(db, item, pullNumber, caps.pullHead).catch(() => null);
  return {
    pullNumber,
    threads,
    findings,
    head: head === "unreadable" ? null : head,
    started,
  };
}

export function storedFeedbackReads(
  db: Database,
  item: WorkItemRecord,
  now: number,
): FeedbackReads | null {
  const pullNumber = getItemPullRequest(db, item.id)?.pullNumber;
  if (pullNumber === undefined || pendingPullComments(db, item.id).length === 0) return null;
  return { pullNumber, threads: [], findings: [], head: null, started: now };
}

export function pendingFeedback(
  db: Database,
  item: WorkItemRecord,
  reads: FeedbackReads,
  now: number,
  options: { ci?: boolean } = {},
): PendingFeedback {
  const { pullNumber, threads, findings } = reads;
  settleCovered(db, pendingPullComments(db, item.id), now);
  const batch =
    pendingChangeRequests(db, item.id).length > 0
      ? []
      : pendingPullComments(db, item.id).filter((comment) => comment.pullNumber === pullNumber);
  const digest = batch.length === 0 ? null : commentDigest(batch, threads);
  if (digest === null && batch.length > 0) settlePullComments(db, batch, "dropped", now);
  const comments = digest === null ? [] : batch;
  const failure =
    options.ci === false
      ? null
      : currentPullCi(db, item, now, { pullNumber, head: reads.head, observedBy: reads.started });
  const targets = replyTargets({ pullNumber, threads, reviews: [], comments });
  return { pullNumber, comments, digest, failure, targets, findings };
}

export function hasFeedback(feedback: PendingFeedback | null): feedback is PendingFeedback {
  return feedback !== null && (feedback.comments.length > 0 || feedback.failure !== null);
}

export function feedbackHandoff(lead: readonly string[], feedback: PendingFeedback | null): string {
  const comments = feedback !== null && feedback.comments.length > 0 ? feedback : null;
  return [
    ...lead,
    feedback?.failure ? pullCiHandoff(feedback.failure) : "",
    comments && lead.includes(REBASE_CONFLICT_INSTRUCTION) ? REBASED_LINES_NOTE : "",
    comments?.digest ?? "",
    comments ? closeoutFindingsNote(comments.findings, comments.comments) : "",
    comments ? COMMENT_FIX_INSTRUCTION : "",
    feedback ? replyListSection(feedback.targets) : "",
  ]
    .filter((part) => part !== "")
    .join("\n\n");
}

export function restartWithFeedback(
  db: Database,
  item: WorkItemRecord,
  input: Omit<RestartHandoff, "body" | "fixRound"> & {
    lead: readonly string[];
    reads: FeedbackReads | null;
    ci?: boolean;
    fixRoundLimit: number;
    sessionId: string | null;
  },
): number | null {
  const { lead, reads, ci, fixRoundLimit, sessionId, ...handoff } = input;
  const fixRound = !FIX_REASONS.includes(handoff.reason);
  const carried =
    reads !== null && (!fixRound || fixRounds(db, item.id) < fixRoundLimit)
      ? pendingFeedback(db, item, reads, handoff.now, ci === false ? { ci } : {})
      : null;
  const feedback = hasFeedback(carried) ? carried : null;
  const jobKey =
    handoff.jobKey ??
    (feedback === null ? undefined : `${handoff.reason}:${item.id}:${item.version}`);
  const jobId = restart(db, item, {
    ...handoff,
    body: feedbackHandoff(lead, feedback),
    ...(jobKey === undefined ? {} : { jobKey }),
    ...(feedback !== null && fixRound ? { fixRound } : {}),
  });
  if (jobId !== null && feedback !== null && jobKey !== undefined)
    deliverFeedback(db, item, feedback, {
      jobKey,
      sessionId,
      limit: fixRoundLimit,
      now: handoff.now,
    });
  return jobId;
}

const FIX_REASONS: readonly string[] = ["findings", "ci", "review"];

export function deliverFeedback(
  db: Database,
  item: WorkItemRecord,
  feedback: PendingFeedback,
  input: { jobKey: string; sessionId: string | null; limit: number; now: number },
): void {
  const { comments, failure, pullNumber } = feedback;
  const { jobKey, sessionId, now } = input;
  if (comments.length > 0) {
    postPullFeedback(db, {
      sessionId,
      item,
      key: jobKey,
      body: `${authors(comments)} commented on pull request #${pullNumber}. The agent is working on the comments.`,
      now,
    });
    recordReplyTargets(db, item.id, jobKey, feedback.targets, now);
    if (item.acceptedHead !== null)
      recordReviewEscape(db, {
        triggerKey: jobKey,
        itemId: item.id,
        trigger: "comment",
        acceptedHead: item.acceptedHead,
        pullNumber,
        detail: {
          comments: comments
            .filter((comment) => comment.body.trim() !== "")
            .map((comment) => ({
              id: comment.commentId,
              author: comment.author,
              body: comment.body,
            })),
        },
        recordedAt: now,
      });
    settlePullComments(db, comments, "restarted", now);
  }
  if (failure !== null)
    postPullFeedback(db, {
      sessionId,
      item,
      key: `${jobKey}:ci`,
      body: pullCiRestarted(db, { item, failure, jobKey, limit: input.limit, now }),
      now,
    });
}

export function settleCovered(
  db: Database,
  comments: readonly PullCommentRecord[],
  now: number,
): number {
  const covered = comments.filter(
    (comment) =>
      comment.source === "inline" &&
      comment.reviewId !== null &&
      getPullReview(db, comment.reviewId) !== null,
  );
  settlePullComments(db, covered, "covered", now);
  return covered.length;
}

export function authors(comments: readonly PullCommentRecord[]): string {
  const names = [...new Set(comments.map((comment) => who(comment.author)))];
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and others`;
}

export function who(author: string | null): string {
  return author ? `@${author}` : "Someone";
}
