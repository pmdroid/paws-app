import type { Database } from "bun:sqlite";
import type { StoredReviewFinding } from "../closeout";
import {
  emitJobReady,
  fixRoundsSteps,
  getItemPullRequestSteps,
  getPullReviewSteps,
  pendingChangeRequestsSteps,
  pendingPullCiFailuresSteps,
  pendingPullCommentsSteps,
  recordReviewEscapeSteps,
  recordReviewRepliesSteps,
  settled,
  settlePullCommentsSteps,
  sqliteDb,
  type Q,
  type Steps,
  type NewReviewReply,
  type RestartHandoff,
  type PullCiFailureRecord,
  type PullCommentRecord,
  type WorkItemRecord,
} from "../db";
import type { ReviewThread } from "../github";
import { REBASE_CONFLICT_INSTRUCTION } from "../merge";
import { restartSteps } from "./operations";
import { COMMENT_FIX_INSTRUCTION, commentDigest } from "./pull-comments";
import { currentPullCiSteps, pullCiHandoff, pullCiHead, pullCiRestartedSteps } from "./pull-ci";
import {
  closeoutFindingsNote,
  postPullFeedbackSteps,
  type PullReviewCapabilities,
} from "./pull-reviews";
import { replyListSection, replyTargets } from "./review-replies";

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
  return settled(sqliteDb(db).run((q) => storedFeedbackReadsSteps(q, item, now)));
}

export function* storedFeedbackReadsSteps(
  q: Q,
  item: WorkItemRecord,
  now: number,
): Steps<FeedbackReads | null> {
  const pullNumber = (yield* getItemPullRequestSteps(q, item.id))?.pullNumber;
  if (pullNumber === undefined || (yield* pendingPullCommentsSteps(q, item.id)).length === 0)
    return null;
  return { pullNumber, threads: [], findings: [], head: null, started: now };
}

export function* pendingFeedbackSteps(
  q: Q,
  item: WorkItemRecord,
  reads: FeedbackReads,
  now: number,
  options: { ci?: boolean } = {},
): Steps<PendingFeedback> {
  const { pullNumber, threads, findings } = reads;
  yield* settleCoveredSteps(q, yield* pendingPullCommentsSteps(q, item.id), now);
  const batch =
    (yield* pendingChangeRequestsSteps(q, item.id)).length > 0
      ? []
      : (yield* pendingPullCommentsSteps(q, item.id)).filter(
          (comment) => comment.pullNumber === pullNumber,
        );
  const digest = batch.length === 0 ? null : commentDigest(batch, threads);
  if (digest === null && batch.length > 0) yield* settlePullCommentsSteps(q, batch, "dropped", now);
  const comments = digest === null ? [] : batch;
  const failure =
    options.ci === false
      ? null
      : yield* currentPullCiSteps(q, item, now, {
          pullNumber,
          head: reads.head,
          observedBy: reads.started,
        });
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

type FeedbackRestart = Omit<RestartHandoff, "body" | "fixRound"> & {
  lead: readonly string[];
  reads: FeedbackReads | null;
  ci?: boolean;
  fixRoundLimit: number;
  sessionId: string | null;
};

export function restartWithFeedback(
  db: Database,
  item: WorkItemRecord,
  input: FeedbackRestart,
): number | null {
  const restarted = settled(
    sqliteDb(db).transaction((q) => restartWithFeedbackSteps(q, item, input)),
  );
  if (restarted?.armed) emitJobReady(db);
  return restarted?.id ?? null;
}

export function* restartWithFeedbackSteps(
  q: Q,
  item: WorkItemRecord,
  input: FeedbackRestart,
): Steps<{ id: number; armed: boolean } | null> {
  const { lead, reads, ci, fixRoundLimit, sessionId, ...handoff } = input;
  const fixRound = !FIX_REASONS.includes(handoff.reason);
  const carried =
    reads !== null && (!fixRound || (yield* fixRoundsSteps(q, item.id)) < fixRoundLimit)
      ? yield* pendingFeedbackSteps(q, item, reads, handoff.now, ci === false ? { ci } : {})
      : null;
  const feedback = hasFeedback(carried) ? carried : null;
  const jobKey =
    handoff.jobKey ??
    (feedback === null ? undefined : `${handoff.reason}:${item.id}:${item.version}`);
  const restarted = yield* restartSteps(q, item, {
    ...handoff,
    body: feedbackHandoff(lead, feedback),
    ...(jobKey === undefined ? {} : { jobKey }),
    ...(feedback !== null && fixRound ? { fixRound } : {}),
  });
  if (restarted !== null && feedback !== null && jobKey !== undefined)
    yield* deliverFeedbackSteps(q, item, feedback, {
      jobKey,
      sessionId,
      limit: fixRoundLimit,
      now: handoff.now,
    });
  return restarted;
}

const FIX_REASONS: readonly string[] = ["findings", "ci", "review"];

export function* deliverFeedbackSteps(
  q: Q,
  item: WorkItemRecord,
  feedback: PendingFeedback,
  input: { jobKey: string; sessionId: string | null; limit: number; now: number },
): Steps<void> {
  const { comments, failure, pullNumber } = feedback;
  const { jobKey, sessionId, now } = input;
  if (comments.length > 0) {
    yield* postPullFeedbackSteps(q, {
      sessionId,
      item,
      key: jobKey,
      body: `${authors(comments)} commented on pull request #${pullNumber}. The agent is working on the comments.`,
      now,
    });
    yield* recordReviewRepliesSteps(q, {
      itemId: item.id,
      restartKey: jobKey,
      replies: feedback.targets,
      now,
    });
    if (item.acceptedHead !== null)
      yield* recordReviewEscapeSteps(q, {
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
    yield* settlePullCommentsSteps(q, comments, "restarted", now);
  }
  if (failure !== null)
    yield* postPullFeedbackSteps(q, {
      sessionId,
      item,
      key: `${jobKey}:ci`,
      body: yield* pullCiRestartedSteps(q, { item, failure, jobKey, limit: input.limit, now }),
      now,
    });
}

export function* settleCoveredSteps(
  q: Q,
  comments: readonly PullCommentRecord[],
  now: number,
): Steps<number> {
  const covered: PullCommentRecord[] = [];
  for (const comment of comments)
    if (
      comment.source === "inline" &&
      comment.reviewId !== null &&
      (yield* getPullReviewSteps(q, comment.reviewId)) !== null
    )
      covered.push(comment);
  yield* settlePullCommentsSteps(q, covered, "covered", now);
  return covered.length;
}

export function authors(comments: readonly PullCommentRecord[]): string {
  const names = [...new Set(comments.map((comment) => who(comment.author)))];
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and others`;
}

export function who(author: string | null): string {
  return author ? `@${author}` : "Someone";
}
