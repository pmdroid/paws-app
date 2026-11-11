import { randomUUID } from "node:crypto";
import {
  emitJobReady,
  openItemIdsForRepositorySteps,
  enqueueOutboxOnceSteps,
  fixRoundsSteps,
  getPullReviewSteps,
  pendingPullCommentsSteps,
  settlePullCommentsSteps,
  getItemPullRequestSteps,
  getWorkItemSteps,
  recordPullReviewSteps,
  recordReviewEscapeSteps,
  recordReviewRepliesSteps,
  settlePullReviewSteps,
  type PullReviewRecord,
  type PullFeedbackWait,
  type PullReviewState,
  type NewOutbox,
  type Q,
  type ReviewCheckWait,
  type Steps,
  type WorkItemRecord,
  type Db,
} from "../db";
import type { StoredReviewFinding } from "../closeout";
import type { LeaveMergeQueueResult, ReviewThread } from "../github";
import { feedbackSeenSteps } from "./feedback-seen";
import { askSteps, restartSteps } from "./operations";
import { commentDigest } from "./pull-comments";
import {
  currentPullCiSteps,
  pullCiAskedSteps,
  pullCiHandoff,
  pullCiHead,
  pullCiRestartedSteps,
} from "./pull-ci";
import { REVIEW_FIX_INSTRUCTION } from "./review-instructions";
import { holdForReviewChecks, type ReviewChecks } from "./review-checks";
import { replyListSection, replyTargets } from "./review-replies";
import { worktreeBranch } from "./sources";

/** How often a review waiting for a live turn, evaluation or merge attempt looks again. */
export const PULL_REVIEW_POLL_MS = 15_000;

const ENDED = new Set(["cancelled", "merged", "completed", "failed", "manual"]);
const COMMENT_CHARS = 2_000;
const DIGEST_CHARS = 12_000;

export { REVIEW_FIX_INSTRUCTION } from "./review-instructions";

/**
 * Record a submitted changes-requested `pull_request_review` webhook for the item that owns the
 * pull request's branch, once per review id. Comment-only reviews are comments
 * (`recordCommentDelivery`); approvals and dismissals only wake the merge job. True when this
 * delivery recorded a new review.
 */
export function* recordReviewDeliverySteps(
  q: Q,
  event: string,
  body: unknown,
  now: number,
  wait?: PullFeedbackWait,
): Steps<{ recorded: boolean; enqueued: boolean }> {
  const none = { recorded: false, enqueued: false };
  if (event !== "pull_request_review") return none;
  const payload = record(body);
  const review = record(payload.review);
  const pull = record(payload.pull_request);
  const head = record(pull.head);
  const state = typeof review.state === "string" ? review.state.toLowerCase() : "";
  if (payload.action !== "submitted" || state !== "changes_requested") return none;
  const reviewId = review.id;
  const pullNumber = pull.number;
  const branch = head.ref;
  const repository = record(payload.repository);
  const owner = record(repository.owner).login;
  const repo = repository.name;
  const headRepository = record(head.repo);
  if (
    typeof reviewId !== "number" ||
    typeof pullNumber !== "number" ||
    typeof branch !== "string" ||
    typeof owner !== "string" ||
    typeof repo !== "string" ||
    // Paws pushes its branch to the base repository. A fork's pull request can reuse the branch
    // name, so the head must live in the same repository.
    typeof headRepository.id !== "number" ||
    headRepository.id !== repository.id
  )
    return none;
  const item = yield* itemForBranchSteps(q, owner, repo, branch);
  if (item === null) return none;
  const opened = yield* getItemPullRequestSteps(q, item.id);
  if (opened !== null && opened.pullNumber !== pullNumber) return none;
  const receipt = yield* recordPullReviewSteps(
    q,
    {
      reviewId,
      itemId: item.id,
      state: state as PullReviewState,
      pullNumber,
      head: typeof review.commit_id === "string" ? review.commit_id : null,
      reviewer:
        typeof record(review.user).login === "string" ? String(record(review.user).login) : null,
      body: typeof review.body === "string" ? review.body : "",
      receivedAt: now,
    },
    wait,
  );
  if (receipt.recorded) yield* feedbackSeenSteps(q, item.id, now);
  return receipt;
}

/** The ongoing item whose branch in `owner/repo` is `branch`. */
export function* itemForBranchSteps(
  q: Q,
  owner: string,
  repo: string,
  branch: string,
): Steps<WorkItemRecord | null> {
  for (const id of yield* openItemIdsForRepositorySteps(q, owner, repo)) {
    const item = yield* getWorkItemSteps(q, id);
    if (item && (item.branchName || worktreeBranch(item)) === branch) return item;
  }
  return null;
}

export type PullReviewCapabilities = {
  now(): number;
  /** A turn, evaluation or merge attempt of this item is running in this process. */
  busy(item: WorkItemRecord): Promise<boolean>;
  /**
   * Take the pull request out of GitHub's merge queue, so GitHub cannot merge the reviewed head
   * while Paws waits. Throws when GitHub cannot be read.
   */
  leaveMergeQueue(item: WorkItemRecord, pullNumber: number): Promise<LeaveMergeQueueResult>;
  /** The pull request's current head commit. Null when GitHub cannot be read. */
  pullHead(item: WorkItemRecord, pullNumber: number): Promise<string | null>;
  /** Unresolved review threads on the pull request. Throws when GitHub cannot be read. */
  threads(item: WorkItemRecord, pullNumber: number): Promise<ReviewThread[]>;
  pullConflict?(item: WorkItemRecord, pullNumber: number): Promise<PullConflict | null>;
  fixRoundLimit(q: Q, item: WorkItemRecord): Steps<number>;
  /** The item's stored Closeout review findings. Empty when none can be read. */
  closeoutFindings(item: WorkItemRecord): Promise<readonly StoredReviewFinding[]>;
  session(item: WorkItemRecord): string | null;
  flush(): Promise<void>;
  reviewChecks?(
    item: WorkItemRecord,
    pullNumber: number,
    since: number,
  ): Promise<ReviewChecks | null>;
  noteReviewWait?(wait: ReviewCheckWait | null): void;
};

export type PullConflict = { head: string; base: string };

export type PullReviewStep = "wait" | "restarted" | "asked" | "dropped" | "done";

/**
 * Act on one recorded review. A changes-requested review waits until the item rests in the merge
 * queue with nothing running, then restarts it with the review and its unresolved threads, or asks
 * the team when the fix rounds are spent.
 */
export async function handlePullReview(
  store: Db,
  reviewId: number,
  caps: PullReviewCapabilities,
): Promise<PullReviewStep> {
  const started = caps.now();
  // One read, so no other job runs between the review and its item, as in the synchronous read.
  const read = await store.run(function* (q) {
    const review = yield* getPullReviewSteps(q, reviewId);
    if (review === null || review.handledAt !== null) return null;
    return { review, item: yield* getWorkItemSteps(q, review.itemId) };
  });
  if (read === null) return "done";
  const { review, item } = read;
  if (item === null || ENDED.has(item.state) || item.cancelRequested) {
    await store.run((q) => settlePullReviewSteps(q, reviewId, "dropped", caps.now()));
    return "dropped";
  }
  if (review.state === "commented") {
    // Recorded before comment-only reviews became comments; `recordCommentDelivery` has them now.
    await store.run((q) => settlePullReviewSteps(q, reviewId, "dropped", caps.now()));
    return "dropped";
  }
  if (item.state === "merge_queue") {
    // Before waiting on anything: GitHub's own merge queue does not wait for Paws.
    const queue = await caps.leaveMergeQueue(item, review.pullNumber);
    if (queue === "merged" || queue === "closed") {
      await store.run((q) => settlePullReviewSteps(q, reviewId, "dropped", caps.now()));
      return "dropped";
    }
  }
  if (item.state !== "merge_queue" || (await caps.busy(item))) return "wait";
  if (await holdForReviewChecks(item, review.pullNumber, review.receivedAt, caps)) return "wait";
  const threads = await caps.threads(item, review.pullNumber);
  const findings = await caps.closeoutFindings(item);
  const head = await pullCiHead(store, item, review.pullNumber, caps.pullHead);
  if (head === "unreadable") return "wait";
  let armed = false;
  const step = await store.transaction(function* (q): Steps<PullReviewStep> {
    const current = yield* getWorkItemSteps(q, item.id);
    if (current === null || current.version !== item.version || current.state !== "merge_queue")
      return "wait";
    const rounds = yield* fixRoundsSteps(q, current.id);
    const limit = yield* caps.fixRoundLimit(q, current);
    // Comments that arrived with the review go to the agent in the same restart.
    const comments = (yield* pendingPullCommentsSteps(q, current.id)).filter(
      (comment) => comment.pullNumber === review.pullNumber,
    );
    const others = comments.filter(
      (comment) => !(comment.source === "inline" && comment.reviewId === review.reviewId),
    );
    const failure = yield* currentPullCiSteps(q, current, caps.now(), {
      pullNumber: review.pullNumber,
      head,
      observedBy: started,
    });
    const digest = [
      reviewDigest(review, threads),
      others.length > 0 ? (commentDigest(others, threads) ?? "") : "",
      failure === null ? "" : pullCiHandoff(failure),
    ]
      .filter((part) => part !== "")
      .join("\n\n");
    if (rounds < limit) {
      const jobKey = `review:${current.id}:${review.reviewId}`;
      const targets = replyTargets({
        pullNumber: review.pullNumber,
        threads,
        reviews: [review],
        comments,
      });
      const restarted = yield* restartSteps(q, current, {
        reason: "review",
        body: [
          digest,
          closeoutFindingsNote(
            findings,
            threads.map((thread) => ({
              path: thread.path,
              line: thread.line,
              author: thread.comments[0]?.author ?? null,
              body: thread.comments[0]?.body ?? "",
            })),
          ),
          REVIEW_FIX_INSTRUCTION,
          replyListSection(targets),
        ]
          .filter((part) => part !== "")
          .join("\n\n"),
        jobKey,
        now: caps.now(),
      });
      if (restarted === null) return "wait";
      armed = restarted.armed;
      yield* postPullFeedbackSteps(q, {
        sessionId: caps.session(current),
        item: current,
        key: jobKey,
        body: `${reviewer(review)} requested changes on pull request #${review.pullNumber}. The agent is working on them.`,
        now: caps.now(),
      });
      yield* recordReviewRepliesSteps(q, {
        itemId: current.id,
        restartKey: jobKey,
        replies: targets,
        now: caps.now(),
      });
      yield* settlePullCommentsSteps(q, comments, "covered", caps.now());
      if (failure !== null)
        yield* postPullFeedbackSteps(q, {
          sessionId: caps.session(current),
          item: current,
          key: `${jobKey}:ci`,
          body: yield* pullCiRestartedSteps(q, {
            item: current,
            failure,
            jobKey,
            limit,
            now: caps.now(),
          }),
          now: caps.now(),
        });
      if (current.acceptedHead !== null)
        yield* recordReviewEscapeSteps(q, {
          triggerKey: jobKey,
          itemId: current.id,
          trigger: "review",
          acceptedHead: current.acceptedHead,
          pullNumber: review.pullNumber,
          detail: {
            comments: [{ id: review.reviewId, author: review.reviewer, body: review.body }],
          },
          recordedAt: caps.now(),
        });
      yield* settlePullReviewSteps(q, reviewId, "restarted", caps.now());
      return "restarted";
    }
    const sessionId = caps.session(current);
    if (sessionId === null) {
      yield* settlePullReviewSteps(q, reviewId, "dropped", caps.now());
      return "dropped";
    }
    yield* askSteps(
      q,
      {
        itemId: current.id,
        runId: current.currentRunId,
        sessionId,
        version: current.version,
      },
      "ci-help",
      `${reviewer(review)} requested changes on pull request #${review.pullNumber}, and all ${limit} fix rounds are spent. Reply with guidance and Paws hands it to the agent with the review, or stop the task.\n\n${digest}`,
      { reason: "budget_spent", now: caps.now() },
    );
    if (failure !== null)
      yield* pullCiAskedSteps(q, { item: current, failure, limit, now: caps.now() });
    yield* settlePullReviewSteps(q, reviewId, "asked", caps.now());
    return "asked";
  });
  if (armed) emitJobReady(store);
  if (step !== "wait") await caps.flush();
  return step;
}

/**
 * Tell the Linear session that review feedback sent the item back to the agent. Posted after the
 * pull request response, so the key carries the `pull-feedback:` prefix the activity gate lets
 * through. A thought, so the session shows the agent working again. Once per restart job key.
 */
export function* postPullFeedbackSteps(q: Q, input: PullFeedback): Steps<void> {
  if (input.sessionId !== null)
    yield* enqueueOutboxOnceSteps(q, pullFeedbackRow(input.sessionId, input));
}

type PullFeedback = {
  sessionId: string | null;
  item: WorkItemRecord;
  key: string;
  body: string;
  now: number;
};

function pullFeedbackRow(sessionId: string, input: PullFeedback): NewOutbox {
  return {
    target: "linear",
    op: "activity",
    orderingKey: sessionId,
    idempotencyKey: `pull-feedback:${input.key}`,
    delivery: "critical",
    payload: {
      id: randomUUID(),
      sessionId,
      itemId: input.item.id,
      issueId: input.item.linearIssueId,
      kind: "thought",
      body: input.body,
    },
    now: input.now,
  };
}

/** The review body and its unresolved threads, as the agent and the team read them. */
export function reviewDigest(review: PullReviewRecord, threads: readonly ReviewThread[]): string {
  const lines = [`${reviewer(review)} requested changes on pull request #${review.pullNumber}.`];
  if (review.body.trim() !== "") lines.push("", "Review:", clip(review.body.trim()));
  if (threads.length > 0) {
    lines.push("", "Unresolved review threads:");
    threads.forEach((thread, index) => lines.push(threadLines(thread, index + 1)));
  }
  return clip(lines.join("\n"), DIGEST_CHARS);
}

/** A pull request comment that may contradict a Closeout finding. */
export type HandoffComment = {
  path: string | null;
  line: number | null;
  author: string | null;
  body: string;
};

/**
 * Closeout's stored review findings and what the agent does when a comment contradicts one, as
 * the restart handoff for a pull request comment or review reads them. A comment on a file a
 * finding names is quoted next to that finding. Empty without findings.
 */
export function closeoutFindingsNote(
  findings: readonly StoredReviewFinding[],
  comments: readonly HandoffComment[],
): string {
  if (findings.length === 0) return "";
  const lines = [
    "Closeout's independent review reported these findings before the pull request opened. A fixed finding was changed because of the review; an open one was reported by the latest review round and left as it is.",
    ...findings.map(
      (finding) =>
        `- ${finding.status}, ${finding.severity} at \`${finding.location}\`: ${finding.explanation}`,
    ),
  ];
  const overlaps = comments.flatMap((comment) =>
    findings
      .filter((finding) => samePath(comment.path, finding.path))
      .map((finding) => ({ comment, finding })),
  );
  if (overlaps.length > 0) {
    lines.push("", "These comments are on a file a Closeout finding names. Compare both sides:");
    for (const { comment, finding } of overlaps)
      lines.push(
        `- ${comment.author ? `@${comment.author}` : "Someone"} at \`${comment.path}${comment.line === null ? "" : `:${comment.line}`}\`: ${quote(comment.body)}`,
        `  Closeout (${finding.status}) at \`${finding.location}\`: ${quote(finding.explanation)}`,
      );
  }
  lines.push("", CONTRADICTION_INSTRUCTION);
  return lines.join("\n");
}

export const CONTRADICTION_INSTRUCTION =
  "If a comment asks to undo or contradict a fix made for a Closeout finding, or contradicts an open finding, do not change the code for it. Ask the team with ask_team in this session, quote the comment and the finding, and wait for the answer. A comment from a person wins once that person confirms it in the session. Comments that do not touch a finding are handled as usual.";

function samePath(comment: string | null, finding: string | null): boolean {
  if (!comment || !finding) return false;
  return comment === finding || comment.endsWith(`/${finding}`) || finding.endsWith(`/${comment}`);
}

function quote(text: string): string {
  return `"${clip(text.replace(/\s+/g, " ").trim(), 400)}"`;
}

export function threadLines(thread: ReviewThread, index: number): string {
  const where = thread.path
    ? `\`${thread.path}${thread.line === null ? "" : `:${thread.line}`}\``
    : "general";
  const header = `${index}. ${where}${thread.outdated ? " (outdated)" : ""}`;
  const comments = thread.comments.map(
    (comment) =>
      `   ${comment.author ? `@${comment.author}` : "Someone"}: ${clip(comment.body.trim()).replaceAll("\n", "\n   ")}`,
  );
  return [header, ...comments].join("\n");
}

function reviewer(review: PullReviewRecord): string {
  return review.reviewer ? `@${review.reviewer}` : "A reviewer";
}

export function clip(text: string, chars = COMMENT_CHARS): string {
  return text.length <= chars ? text : `${text.slice(0, chars - 1)}…`;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
