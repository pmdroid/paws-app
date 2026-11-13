import { JOB_KIND } from "../core";
import {
  enqueueOutboxOnceSteps,
  getItemPullRequestSteps,
  getWorkItemSteps,
  listCiRoundsSteps,
  pendingChangeRequestsSteps,
  pendingItemJobSteps,
  pendingPullCiFailuresSteps,
  pendingPullCommentsSteps,
  pullFeedbackDueSteps,
  queuePositionSteps,
  unreportedReviewRepliesSteps,
  type CiRound,
  type Job,
  type OutboxRow,
  type Q,
  type Steps,
} from "../db";
import { blockingIssuesSteps } from "../intake";
import { REBASE_CONFLICT_INSTRUCTION } from "../merge";
import { CI_REVIEW_WAIT_SOURCE } from "./pull-ci";
import { REVIEW_REPLY_MARKER } from "./review-replies";

const NOTICE_REASONS: readonly string[] = ["review", "ci", "conflict", "findings"];

type RestartPayload = {
  itemId?: string;
  reason?: string;
  handoff?: string;
  fixRound?: boolean;
};

const NOTICED = "<!-- paws-round:noticed -->";
const WORKING = "<!-- paws-round:working -->";
const WORKING_LEAD = "🐾 Paws is working on this:";

type NoticeStage = "noticed" | "working" | "finished";

type Round = { itemId: string; pullNumber: number };

function* noticeSteps(
  q: Q,
  round: Round,
  key: string,
  stage: NoticeStage,
  text: string,
  now: number,
) {
  yield* enqueueOutboxOnceSteps(q, {
    target: "github",
    op: GITHUB_OUTBOX_OP.notice,
    orderingKey: `pull-notice:${round.itemId}`,
    idempotencyKey: key,
    payload: {
      ...round,
      stage,
      body: `${text}\n\n${REVIEW_REPLY_MARKER}\n${stage === "noticed" ? NOTICED : WORKING}`,
    },
    maxAttempts: 3,
    now,
  });
}

function* waitLineSteps(q: Q, itemId: string): Steps<string> {
  const item = yield* getWorkItemSteps(q, itemId);
  if (item?.state === "queued") {
    const blockers = yield* blockingIssuesSteps(q, itemId);
    if (blockers.length > 0) return `Waiting for ${list(blockers)} to merge first.`;
    const ahead = ((yield* queuePositionSteps(q, itemId))?.position ?? 1) - 1;
    return ahead === 0
      ? "Waiting for a runner."
      : `Waiting for a runner (${ahead} item${ahead === 1 ? "" : "s"} ahead).`;
  }
  const due = yield* pullFeedbackDueSteps(q, itemId);
  if (due === null) return "It starts when the current step ends.";
  return `Collecting comments until ${new Date(due).toISOString().slice(11, 16)} UTC, then it starts.`;
}

export function* feedbackNoticeSteps(q: Q, itemId: string, now: number): Steps<void> {
  const pull = yield* getItemPullRequestSteps(q, itemId);
  const comments = (yield* pendingPullCommentsSteps(q, itemId)).length;
  const reviews = (yield* pendingChangeRequestsSteps(q, itemId)).length;
  const failures = (yield* pendingPullCiFailuresSteps(q, itemId)).length;
  const causes = [
    comments > 0 ? `${comments} review comment${comments === 1 ? "" : "s"}` : "",
    comments === 0 && reviews > 0 ? "review feedback" : "",
    failures > 0 ? "failing CI" : "",
  ].filter((cause) => cause !== "");
  if (pull === null || causes.length === 0) return;
  const text = `🐾 Paws noticed this: ${list(causes)}. ${yield* waitLineSteps(q, itemId)}`;
  const key = `github-noticed:${itemId}:${comments}:${reviews}:${failures}:${now}`;
  yield* noticeSteps(q, { itemId, pullNumber: pull.pullNumber }, key, "noticed", text, now);
}

export function* queuedNoticeSteps(q: Q, itemId: string, now: number): Steps<void> {
  const job = yield* pendingItemJobSteps(q, JOB_KIND.resume, itemId);
  const round = job === null ? null : yield* roundSteps(q, job);
  if (job === null || round === null) return;
  const wait = yield* waitLineSteps(q, itemId);
  const text = `🐾 Paws noticed this: ${list(round.causes)}. ${wait}`;
  yield* noticeSteps(q, round, `github-noticed:${roundKey(job)}:${wait}`, "noticed", text, now);
}

type NoticeJob = Pick<Job, "id" | "activationId" | "jobKey" | "payload">;

function roundKey(job: NoticeJob): string {
  return job.jobKey ?? `${job.id}:${job.activationId}`;
}

function* roundSteps(q: Q, job: NoticeJob) {
  const payload = (job.payload ?? {}) as RestartPayload;
  const { itemId, reason = "" } = payload;
  if (!itemId || !(NOTICE_REASONS.includes(reason) || payload.fixRound === true)) return null;
  const pull = yield* getItemPullRequestSteps(q, itemId);
  if (pull === null) return null;
  const targets =
    job.jobKey === null
      ? []
      : (yield* unreportedReviewRepliesSteps(q, itemId)).filter(
          (reply) => reply.restartKey === job.jobKey && reply.pullNumber === pull.pullNumber,
        );
  const handoff = payload.handoff ?? "";
  const causes: string[] = [];
  if (targets.length > 0)
    causes.push(`${targets.length} review comment${targets.length === 1 ? "" : "s"}`);
  else if (reason === "review") causes.push("review feedback");
  if (reason === "ci" || handoff.includes(CI_REVIEW_WAIT_SOURCE))
    causes.push(ciCause(yield* listCiRoundsSteps(q, itemId)));
  if (reason === "conflict" || handoff.includes(REBASE_CONFLICT_INSTRUCTION))
    causes.push("a merge conflict with main");
  if (reason === "findings") causes.push("Closeout findings");
  if (causes.length === 0) causes.push("pull request feedback");
  return { itemId, pullNumber: pull.pullNumber, targets, causes };
}

export function* fixRoundNoticeSteps(q: Q, job: NoticeJob, now: number): Steps<number> {
  const round = yield* roundSteps(q, job);
  if (round === null) return 0;
  const text = `${WORKING_LEAD} ${list(round.causes)}.`;
  yield* noticeSteps(q, round, `github-working:${roundKey(job)}`, "working", text, now);
  const reacted = round.targets.filter((target) => target.commentId !== null);
  for (const { target, commentId } of reacted) {
    const source = target === "thread" ? "inline" : target;
    yield* seenReactionSteps(q, { ...round, source, commentId: commentId! }, now);
  }
  return 1 + reacted.filter((target) => target.target !== "review").length;
}

export function* fixRoundFinishedSteps(q: Q, job: NoticeJob, now: number): Steps<void> {
  const round = yield* roundSteps(q, job);
  const key = `github-finished:${roundKey(job)}:${job.activationId}`;
  if (round !== null) yield* noticeSteps(q, round, key, "finished", "", now);
}

function seenReactionKey(target: "thread" | "conversation", commentId: number): string {
  return `github-seen:${target}:${commentId}`;
}

/**
 * Queue 👀 on an inline or conversation comment Paws recorded, in the receipt transaction, so the
 * person sees it arrived before the collection window ends. A review body gets none.
 */
export function* seenReactionSteps(
  q: Q,
  comment: { source: string; commentId: number; itemId: string; pullNumber: number },
  now: number,
): Steps<void> {
  if (comment.source !== "inline" && comment.source !== "conversation") return;
  const inline = comment.source === "inline";
  yield* enqueueOutboxOnceSteps(q, {
    target: "github",
    op: GITHUB_OUTBOX_OP.reaction,
    idempotencyKey: seenReactionKey(inline ? "thread" : "conversation", comment.commentId),
    payload: {
      itemId: comment.itemId,
      pullNumber: comment.pullNumber,
      commentId: comment.commentId,
      on: inline ? "review" : "conversation",
    },
    maxAttempts: 3,
    now,
  });
}

export const GITHUB_OUTBOX_OP = {
  comment: "pull.comment",
  reaction: "comment.reaction",
  notice: "pull.notice",
} as const;

export type GitHubOutboxWrites = {
  commentOnPullRequest(prNumber: number, body: string): Promise<void>;
  reactToComment(commentId: number, on: "review" | "conversation"): Promise<void>;
  pullRequestComments(prNumber: number): Promise<{ id: number; body: string }[]>;
  editComment(commentId: number, body: string): Promise<void>;
};

export async function deliverGitHubOutbox(
  message: Pick<OutboxRow, "op" | "payload">,
  github: GitHubOutboxWrites,
): Promise<void> {
  const payload = message.payload as {
    pullNumber: number;
    body?: string;
    commentId?: number;
    on?: "review" | "conversation";
    stage?: NoticeStage;
  };
  if (message.op === GITHUB_OUTBOX_OP.notice && payload.body !== undefined && payload.stage)
    return deliverNotice(github, payload.pullNumber, payload.stage, payload.body);
  if (message.op === GITHUB_OUTBOX_OP.comment && payload.body !== undefined)
    return github.commentOnPullRequest(payload.pullNumber, payload.body);
  if (message.op === GITHUB_OUTBOX_OP.reaction && payload.commentId !== undefined && payload.on)
    return github.reactToComment(payload.commentId, payload.on);
  throw new Error(`Unknown GitHub outbox op: ${message.op}`);
}

async function deliverNotice(
  github: GitHubOutboxWrites,
  pullNumber: number,
  stage: NoticeStage,
  body: string,
): Promise<void> {
  const comments = await github.pullRequestComments(pullNumber);
  const open = comments.findLast((comment) =>
    comment.body.includes(stage === "finished" ? WORKING : NOTICED),
  );
  if (stage === "finished") {
    if (open)
      await github.editComment(
        open.id,
        open.body.replace(WORKING_LEAD, "🐾 Paws worked on this:").replace(`\n${WORKING}`, ""),
      );
    return;
  }
  if (open) return github.editComment(open.id, body);
  return github.commentOnPullRequest(pullNumber, body);
}

function ciCause(rounds: readonly CiRound[]): string {
  const round = rounds.findLast((entry) => entry.next === "agent");
  const failed = round?.checks.filter((check) => check.state === "failed") ?? [];
  if (!round || failed.length === 0) return "failing CI";
  const names = failed.map((check) => check.name).join(", ");
  return `CI: ${names}${round.fix === null ? "" : ` (${round.fix}/${round.fixLimit})`}`;
}

function list(parts: readonly string[]): string {
  return parts.length <= 1
    ? parts.join("")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
