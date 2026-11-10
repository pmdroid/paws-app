import {
  enqueueOutboxOnceSteps,
  getItemPullRequestSteps,
  listCiRoundsSteps,
  unreportedReviewRepliesSteps,
  type CiRound,
  type Job,
  type OutboxRow,
  type Q,
  type Steps,
} from "../db";
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

export function* fixRoundNoticeSteps(
  q: Q,
  job: Pick<Job, "id" | "activationId" | "jobKey" | "payload">,
  now: number,
): Steps<number> {
  const payload = (job.payload ?? {}) as RestartPayload;
  const { itemId, reason = "" } = payload;
  if (!itemId || !(NOTICE_REASONS.includes(reason) || payload.fixRound === true)) return 0;
  const pull = yield* getItemPullRequestSteps(q, itemId);
  if (pull === null) return 0;
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
  const key = `github-working:${job.jobKey ?? `${job.id}:${job.activationId}`}`;
  let queued = 0;
  const enqueue = function* (idempotencyKey: string, op: string, body: Record<string, unknown>) {
    const row = { itemId, pullNumber: pull.pullNumber, ...body };
    yield* enqueueOutboxOnceSteps(q, {
      target: "github",
      op,
      idempotencyKey,
      payload: row,
      maxAttempts: 3,
      now,
    });
    queued += 1;
  };
  yield* enqueue(key, GITHUB_OUTBOX_OP.comment, {
    body: `🐾 Paws is working on this: ${list(causes)}.\n\n${REVIEW_REPLY_MARKER}`,
  });
  for (const target of targets) {
    if (target.commentId === null || target.target === "review") continue;
    yield* enqueue(`${key}:eyes:${target.target}:${target.commentId}`, GITHUB_OUTBOX_OP.reaction, {
      commentId: target.commentId,
      on: target.target === "thread" ? "review" : "conversation",
    });
  }
  return queued;
}

export const GITHUB_OUTBOX_OP = { comment: "pull.comment", reaction: "comment.reaction" } as const;

export type GitHubOutboxWrites = {
  commentOnPullRequest(prNumber: number, body: string): Promise<void>;
  reactToComment(commentId: number, on: "review" | "conversation"): Promise<void>;
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
  };
  if (message.op === GITHUB_OUTBOX_OP.comment && payload.body !== undefined)
    return github.commentOnPullRequest(payload.pullNumber, payload.body);
  if (message.op === GITHUB_OUTBOX_OP.reaction && payload.commentId !== undefined && payload.on)
    return github.reactToComment(payload.commentId, payload.on);
  throw new Error(`Unknown GitHub outbox op: ${message.op}`);
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
