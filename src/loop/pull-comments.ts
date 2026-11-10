import type { Database } from "bun:sqlite";
import {
  emitJobReady,
  openItemIdForPullSteps,
  fixRoundsSteps,
  getItemPullRequestSteps,
  getWorkItemSteps,
  pendingChangeRequestsSteps,
  pendingPullCiFailuresSteps,
  pendingPullCommentsSteps,
  rebaseReturnedForSteps,
  recordPullCommentSteps,
  recordRebaseReturnSteps,
  restartSteps,
  settled,
  settlePullCiFailuresSteps,
  settlePullCommentsSteps,
  sqliteDb,
  type PullCommentRecord,
  type PullFeedbackWait,
  type Q,
  type Steps,
  type WorkItemRecord,
} from "../db";
import type { ReviewThread } from "../github";
import { REBASE_CONFLICT_INSTRUCTION, rebaseBudgetFor } from "../merge";
import { ask } from "./operations";
import {
  authors,
  deliverFeedback,
  feedbackHandoff,
  hasFeedback,
  pendingFeedback,
  settleCovered,
  who,
} from "./pending-feedback";
import { currentPullCi, pullCiHead, pullCiAsked, pullCiHandoff, pullCiQuestion } from "./pull-ci";
import { REVIEW_REPLY_MARKER } from "./review-replies";
import { holdForReviewChecks } from "./review-checks";
import { REVIEW_FIX_INSTRUCTION } from "./review-instructions";
import {
  clip,
  itemForBranch,
  threadLines,
  type PullReviewCapabilities,
  type PullReviewStep,
} from "./pull-reviews";

const ENDED = new Set(["cancelled", "merged", "completed", "failed", "manual"]);
const DIGEST_CHARS = 12_000;

export const COMMENT_FIX_INSTRUCTION = `A comment can be a question, a note or a status line rather than a request; change nothing for those and answer them in the reply list. ${REVIEW_FIX_INSTRUCTION}`;

export const SUGGESTED_FINDINGS_INSTRUCTION =
  "These review findings didn't block. For each one, decide whether to fix it in this pull request. Fix it if it's a real bug in code you changed and the fix is small and safe. Otherwise leave it and say why in one sentence.";

export const SUGGESTION_TURN_HANDOFF =
  "Closeout accepted this head. Its review reported findings below the blocking level; this turn is for them.";

export function suggestedFindingsSection(
  findings: readonly {
    id: string;
    severity: string;
    location: string;
    explanation: string;
    reviewId: string;
  }[],
): string {
  if (findings.length === 0) return "";
  return [
    "Suggested review findings:",
    ...findings.map(
      (finding) =>
        `${finding.id}. ${finding.severity} ${finding.location} (${finding.reviewId}): ${clip(finding.explanation.replace(/\s+/g, " ").trim(), 600)}`,
    ),
    "",
    SUGGESTED_FINDINGS_INSTRUCTION,
    "Paws records your decision, not GitHub. End your final message with a `Finding decisions` section that has one line for every finding above, in this form:",
    `${findings[0]!.id} fixed: what you changed`,
    `${findings[0]!.id} declined: why you left it, in one sentence`,
  ].join("\n");
}

/** Which comments never reach the agent. */
export type PullCommentFilter = {
  /** The Paws GitHub App id for `owner/repo`; comments made through it are its own. */
  appId(repository: string): string | null;
  /** The Paws App's bot login for `owner/repo`, when known. */
  appLogin(repository: string): string | null;
  /** Lowercased bot logins whose comments only report status on `owner/repo`. */
  ignoredBots(repository: string): readonly string[];
  ignoredMarkers(repository: string): readonly string[];
  /** How long comments and reviews are collected before one restart; the defaults when missing. */
  commentWait?(): PullFeedbackWait;
};

const NO_FILTER: PullCommentFilter = {
  appId: () => null,
  appLogin: () => null,
  ignoredBots: () => [],
  ignoredMarkers: () => [],
};

/**
 * Record a new comment on a pull request Paws opened: a comment-only review, an inline review
 * comment or a conversation comment, from a person or another bot. Edits, deletions, the Paws
 * App's own comments, bots on the repository's ignore list, forks and ended items record nothing.
 * True when this delivery recorded a new comment.
 */
export function recordCommentDelivery(
  db: Database,
  event: string,
  body: unknown,
  now: number,
  filter: PullCommentFilter = NO_FILTER,
): boolean {
  return prepareCommentDelivery(db, event, body, now, filter)?.() ?? false;
}

/** Resolve filtering before the receipt transaction; callbacks may start provider work. */
export function prepareCommentDelivery(
  db: Database,
  event: string,
  body: unknown,
  now: number,
  filter: PullCommentFilter = NO_FILTER,
): (() => boolean) | null {
  const payload = record(body);
  const repository = record(payload.repository);
  const owner = record(repository.owner).login;
  const repo = repository.name;
  if (typeof owner !== "string" || typeof repo !== "string") return null;
  const name = `${owner}/${repo}`;
  const comment =
    event === "pull_request_review"
      ? record(payload.review)
      : event === "pull_request_review_comment" || event === "issue_comment"
        ? record(payload.comment)
        : null;
  if (comment === null) return null;
  const expected = event === "pull_request_review" ? "submitted" : "created";
  if (payload.action !== expected) return null;
  if (
    event === "pull_request_review" &&
    (typeof comment.state !== "string" || comment.state.toLowerCase() !== "commented")
  )
    return null;
  const commentId = comment.id;
  if (typeof commentId !== "number") return null;
  const user = record(comment.user);
  const author = typeof user.login === "string" ? user.login : null;
  const viaApp = record(comment.performed_via_github_app).id;
  const appId = filter.appId(name);
  const appLogin = filter.appLogin(name);
  if (appId !== null && viaApp !== undefined && String(viaApp) === appId) return null;
  if (author !== null) {
    const login = author.toLowerCase();
    if (appLogin !== null && login === appLogin.toLowerCase()) return null;
    if (filter.ignoredBots(name).includes(login)) return null;
  }
  const text = typeof comment.body === "string" ? comment.body : "";
  if (filter.ignoredMarkers(name).some((marker) => marker !== "" && text.includes(marker)))
    return null;
  const wait = filter.commentWait?.();
  // Paws' own replies to handed-off comments, posted with a token that is not the App's.
  if (text.includes(REVIEW_REPLY_MARKER)) return null;
  if (event === "issue_comment") {
    const issue = record(payload.issue);
    if (typeof issue.number !== "number" || issue.pull_request === undefined) return null;
    const pullNumber = issue.number;
    return commitDelivery(db, function* (q) {
      // A conversation comment names no branch; only a pull request Paws recorded opening counts,
      // which also leaves out every fork.
      const item = yield* itemForPullSteps(q, owner, repo, pullNumber);
      if (item === null) return NOT_RECORDED;
      return yield* recordPullCommentSteps(
        q,
        {
          source: "conversation",
          commentId,
          itemId: item.id,
          pullNumber,
          reviewId: null,
          author,
          body: text,
          path: null,
          line: null,
          receivedAt: now,
        },
        wait,
      );
    });
  }
  const pull = record(payload.pull_request);
  const head = record(pull.head);
  const pullNumber = pull.number;
  const branch = head.ref;
  if (
    typeof pullNumber !== "number" ||
    typeof branch !== "string" ||
    // Paws pushes its branch to the base repository; a fork can reuse the branch name.
    typeof record(head.repo).id !== "number" ||
    record(head.repo).id !== repository.id
  )
    return null;
  const inline = event === "pull_request_review_comment";
  return commitDelivery(db, function* (q) {
    const item = itemForBranch(db, owner, repo, branch);
    if (item === null) return NOT_RECORDED;
    const opened = yield* getItemPullRequestSteps(q, item.id);
    if (opened !== null && opened.pullNumber !== pullNumber) return NOT_RECORDED;
    const reviewId = inline ? comment.pull_request_review_id : commentId;
    const line = comment.line ?? comment.original_line;
    return yield* recordPullCommentSteps(
      q,
      {
        source: inline ? "inline" : "review",
        commentId,
        itemId: item.id,
        pullNumber,
        reviewId: typeof reviewId === "number" ? reviewId : null,
        author,
        body: text,
        path: inline && typeof comment.path === "string" ? comment.path : null,
        line: inline && typeof line === "number" ? line : null,
        receivedAt: now,
      },
      wait,
    );
  });
}

type CommentReceipt = { recorded: boolean; enqueued: boolean };

const NOT_RECORDED: CommentReceipt = { recorded: false, enqueued: false };

/** Synchronous until `acceptGitHubDelivery` can await its receipt transaction. */
function commitDelivery(db: Database, steps: (q: Q) => Steps<CommentReceipt>): () => boolean {
  return () => {
    const { recorded, enqueued } = settled(sqliteDb(db).transaction(steps));
    if (enqueued) emitJobReady(db);
    return recorded;
  };
}

function* itemForPullSteps(
  q: Q,
  owner: string,
  repo: string,
  pullNumber: number,
): Steps<WorkItemRecord | null> {
  const id = yield* openItemIdForPullSteps(q, owner, repo, pullNumber);
  return id === null ? null : yield* getWorkItemSteps(q, id);
}

/**
 * Act on an item's open comments together. Comments that a changes-requested review already
 * carries are covered. The rest wait until the item rests in the merge queue with nothing
 * running, then restart it once with every comment and its unresolved thread, or ask the team
 * when the fix rounds are spent.
 */
export async function handlePullComments(
  db: Database,
  itemId: string,
  caps: PullReviewCapabilities,
): Promise<PullReviewStep> {
  const store = sqliteDb(db);
  const started = caps.now();
  const open = await store.run((q) => pendingPullCommentsSteps(q, itemId));
  const failures = await store.run((q) => pendingPullCiFailuresSteps(q, itemId));
  if (open.length === 0 && failures.length === 0) return "done";
  const item = await store.run((q) => getWorkItemSteps(q, itemId));
  if (item === null || ENDED.has(item.state) || item.cancelRequested) {
    await store.run((q) => settlePullCommentsSteps(q, open, "dropped", caps.now()));
    await store.run((q) => settlePullCiFailuresSteps(q, failures, "dropped", caps.now()));
    return "dropped";
  }
  const ci = currentPullCi(db, item, caps.now());
  if (settleCovered(db, open, caps.now()) === open.length && ci === null) return "done";
  // A changes-requested review still waiting takes these comments with it.
  if ((await store.run((q) => pendingChangeRequestsSteps(q, itemId))).length > 0) return "wait";
  const pullNumber = open.at(-1)?.pullNumber ?? ci!.pullNumber;
  if (item.state === "merge_queue") {
    // Before waiting on anything: GitHub's own merge queue does not wait for Paws.
    const queue = await caps.leaveMergeQueue(item, pullNumber);
    if (queue === "merged" || queue === "closed") {
      await store.run(function* (q) {
        const comments = yield* pendingPullCommentsSteps(q, itemId);
        yield* settlePullCommentsSteps(q, comments, "dropped", caps.now());
      });
      await store.run(function* (q) {
        const pending = yield* pendingPullCiFailuresSteps(q, itemId);
        yield* settlePullCiFailuresSteps(q, pending, "dropped", caps.now());
      });
      return "dropped";
    }
  }
  if (item.state !== "merge_queue" || (await caps.busy(item))) return "wait";
  if (open.length > 0 && (await holdForReviewChecks(item, pullNumber, open[0]!.receivedAt, caps)))
    return "wait";
  const threads = open.length > 0 ? await caps.threads(item, pullNumber) : [];
  const findings = await caps.closeoutFindings(item);
  const head = await pullCiHead(db, item, pullNumber, caps.pullHead);
  if (head === "unreadable") return "wait";
  const conflict = (await caps.pullConflict?.(item, pullNumber)) ?? null;
  const job = { ready: false };
  const step = await store.transaction(function* (q): Steps<PullReviewStep> {
    const current = yield* getWorkItemSteps(q, item.id);
    if (current === null || current.version !== item.version || current.state !== "merge_queue")
      return "wait";
    const now = caps.now();
    const feedback = pendingFeedback(
      db,
      current,
      { pullNumber, threads, findings, head, started },
      now,
    );
    if (!hasFeedback(feedback)) return "done";
    const { comments, digest, failure } = feedback;
    const rounds = yield* fixRoundsSteps(q, current.id);
    const limit = caps.fixRoundLimit(current);
    if (rounds < limit) {
      const first = comments[0];
      const jobKey = first
        ? `review:${current.id}:${first.source}:${first.commentId}`
        : `ci:${current.id}:${failure!.head}`;
      const rebase =
        conflict !== null &&
        !(yield* rebaseReturnedForSteps(q, current.id, conflict.head)) &&
        rebaseBudgetFor(db, current.id, { ...conflict, files: null, reason: "merge" }, now).allowed
          ? conflict
          : null;
      const restarted = yield* restartSteps(q, current, {
        reason: comments.length > 0 ? "review" : "ci",
        body: feedbackHandoff(rebase ? [REBASE_CONFLICT_INSTRUCTION] : [], feedback),
        jobKey,
        now,
      });
      if (restarted === null) return "wait";
      job.ready = restarted.armed;
      if (rebase)
        yield* recordRebaseReturnSteps(q, {
          itemId: current.id,
          jobId: restarted.id,
          candidate: rebase.head,
          reason: "merge",
          base: rebase.base,
          files: null,
          recordedAt: now,
        });
      deliverFeedback(db, current, feedback, {
        jobKey,
        sessionId: caps.session(current),
        limit,
        now,
      });
      return "restarted";
    }
    const sessionId = caps.session(current);
    if (sessionId === null) {
      yield* settlePullCommentsSteps(q, comments, "dropped", now);
      if (failure !== null) yield* settlePullCiFailuresSteps(q, [failure], "dropped", now);
      return "dropped";
    }
    ask(
      db,
      { itemId: current.id, runId: current.currentRunId, sessionId, version: current.version },
      "ci-help",
      comments.length > 0
        ? [
            `${authors(comments)} commented on pull request #${pullNumber}, and all ${limit} fix rounds are spent. Reply with guidance and Paws hands it to the agent with the comments, or stop the task.\n\n${digest}`,
            failure === null ? "" : pullCiHandoff(failure),
          ]
            .filter((part) => part !== "")
            .join("\n\n")
        : pullCiQuestion(db, failure!, limit),
      { reason: "budget_spent", now },
    );
    yield* settlePullCommentsSteps(q, comments, "asked", now);
    if (failure !== null) pullCiAsked(db, { item: current, failure, limit, now });
    return "asked";
  });
  if (job.ready) emitJobReady(store);
  if (step !== "wait" && step !== "done") await caps.flush();
  return step;
}

/**
 * The comments and their unresolved threads, as the agent and the team read them. A review and
 * the inline comments submitted with it are one entry. Null when there is nothing to read.
 */
export function commentDigest(
  comments: readonly PullCommentRecord[],
  threads: readonly ReviewThread[],
): string | null {
  const entries: ({ text: string } | { reviewId: number })[] = [];
  const reviews = new Map<number, PullCommentRecord[]>();
  for (const comment of comments) {
    if (comment.source === "conversation" || comment.reviewId === null) {
      if (comment.body.trim() !== "")
        entries.push({
          text: `${who(comment.author)} ${comment.source === "conversation" ? "in the conversation" : "commented"}:\n${indent(clip(comment.body.trim()))}`,
        });
      continue;
    }
    const group = reviews.get(comment.reviewId);
    if (group) group.push(comment);
    else {
      reviews.set(comment.reviewId, [comment]);
      entries.push({ reviewId: comment.reviewId });
    }
  }
  const rendered = entries
    .map((entry) => ("text" in entry ? entry.text : reviewEntry(entry.reviewId)))
    .filter((entry): entry is string => entry !== null);
  function reviewEntry(reviewId: number): string | null {
    const group = reviews.get(reviewId)!;
    const review = group.find((comment) => comment.source === "review");
    const own = threads.filter((thread) =>
      thread.comments.some((comment) => comment.reviewId === reviewId),
    );
    const lines = [`${who((review ?? group[0]!).author)} reviewed:`];
    if (review && review.body.trim() !== "") lines.push(indent(clip(review.body.trim())));
    if (own.length > 0)
      own.forEach((thread, index) => lines.push(indent(threadLines(thread, index + 1))));
    else
      for (const comment of group)
        if (comment.source === "inline" && comment.body.trim() !== "")
          lines.push(indent(`${where(comment)}${clip(comment.body.trim())}`));
    return lines.length > 1 ? lines.join("\n") : null;
  }
  if (rendered.length === 0) return null;
  const pull = comments[0]!.pullNumber;
  const lines = [`New comments on pull request #${pull}.`, ""];
  rendered.forEach((entry, index) => lines.push(`${index + 1}. ${entry}`, ""));
  return clip(lines.join("\n").trimEnd(), DIGEST_CHARS);
}

function where(comment: PullCommentRecord): string {
  if (!comment.path) return "";
  return `\`${comment.path}${comment.line === null ? "" : `:${comment.line}`}\`: `;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
