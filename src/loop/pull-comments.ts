import type { Database } from "bun:sqlite";
import {
  fixRounds,
  getItemPullRequest,
  getPullReview,
  getWorkItem,
  immediate,
  pendingChangeRequests,
  pendingPullComments,
  recordPullComment,
  recordReviewEscape,
  settlePullComments,
  type PullCommentRecord,
  type PullFeedbackWait,
  type WorkItemRecord,
} from "../db";
import type { ReviewThread } from "../github";
import { ask, restart } from "./operations";
import {
  REVIEW_REPLY_MARKER,
  recordReplyTargets,
  replyListSection,
  replyTargets,
} from "./review-replies";
import { REVIEW_FIX_INSTRUCTION } from "./review-instructions";
import {
  clip,
  closeoutFindingsNote,
  itemForBranch,
  postPullFeedback,
  threadLines,
  type PullReviewCapabilities,
  type PullReviewStep,
} from "./pull-reviews";

const ENDED = new Set(["cancelled", "merged", "completed", "failed", "manual"]);
const DIGEST_CHARS = 12_000;

export const COMMENT_FIX_INSTRUCTION = `A comment can be a question, a note or a status line rather than a request; change nothing for those and answer them in the reply list. ${REVIEW_FIX_INSTRUCTION}`;

/** Which comments never reach the agent. */
export type PullCommentFilter = {
  /** The Paws GitHub App id for `owner/repo`; comments made through it are its own. */
  appId(repository: string): string | null;
  /** The Paws App's bot login for `owner/repo`, when known. */
  appLogin(repository: string): string | null;
  /** Lowercased bot logins whose comments only report status on `owner/repo`. */
  ignoredBots(repository: string): readonly string[];
  /** How long comments and reviews are collected before one restart; the defaults when missing. */
  commentWait?(): PullFeedbackWait;
};

const NO_FILTER: PullCommentFilter = {
  appId: () => null,
  appLogin: () => null,
  ignoredBots: () => [],
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
  const payload = record(body);
  const repository = record(payload.repository);
  const owner = record(repository.owner).login;
  const repo = repository.name;
  if (typeof owner !== "string" || typeof repo !== "string") return false;
  const name = `${owner}/${repo}`;
  const comment =
    event === "pull_request_review"
      ? record(payload.review)
      : event === "pull_request_review_comment" || event === "issue_comment"
        ? record(payload.comment)
        : null;
  if (comment === null) return false;
  const expected = event === "pull_request_review" ? "submitted" : "created";
  if (payload.action !== expected) return false;
  if (
    event === "pull_request_review" &&
    (typeof comment.state !== "string" || comment.state.toLowerCase() !== "commented")
  )
    return false;
  const commentId = comment.id;
  if (typeof commentId !== "number") return false;
  const user = record(comment.user);
  const author = typeof user.login === "string" ? user.login : null;
  const viaApp = record(comment.performed_via_github_app).id;
  const appId = filter.appId(name);
  const appLogin = filter.appLogin(name);
  if (appId !== null && viaApp !== undefined && String(viaApp) === appId) return false;
  if (author !== null) {
    const login = author.toLowerCase();
    if (appLogin !== null && login === appLogin.toLowerCase()) return false;
    if (filter.ignoredBots(name).includes(login)) return false;
  }
  const text = typeof comment.body === "string" ? comment.body : "";
  // Paws' own replies to handed-off comments, posted with a token that is not the App's.
  if (text.includes(REVIEW_REPLY_MARKER)) return false;
  if (event === "issue_comment") {
    const issue = record(payload.issue);
    if (typeof issue.number !== "number" || issue.pull_request === undefined) return false;
    const pullNumber = issue.number;
    return immediate(db, () => {
      // A conversation comment names no branch; only a pull request Paws recorded opening counts,
      // which also leaves out every fork.
      const item = itemForPull(db, owner, repo, pullNumber);
      if (item === null) return false;
      return recordPullComment(
        db,
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
        filter.commentWait?.(),
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
    return false;
  const inline = event === "pull_request_review_comment";
  return immediate(db, () => {
    const item = itemForBranch(db, owner, repo, branch);
    if (item === null) return false;
    const opened = getItemPullRequest(db, item.id);
    if (opened !== null && opened.pullNumber !== pullNumber) return false;
    const reviewId = inline ? comment.pull_request_review_id : commentId;
    const line = comment.line ?? comment.original_line;
    return recordPullComment(
      db,
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
      filter.commentWait?.(),
    );
  });
}

function itemForPull(
  db: Database,
  owner: string,
  repo: string,
  pullNumber: number,
): WorkItemRecord | null {
  const row = db
    .query<{ id: string }, [string, string, number]>(
      `SELECT i.id FROM work_item i
       JOIN work_item_repository r ON r.item_id = i.id
       JOIN item_pull_request p ON p.item_id = i.id
       WHERE lower(r.owner) = lower(?) AND lower(r.repo) = lower(?) AND p.pull_number = ?
         AND i.state NOT IN ('cancelled','merged','completed','failed','manual')
       ORDER BY i.created_at DESC LIMIT 1`,
    )
    .get(owner, repo, pullNumber);
  return row === null ? null : getWorkItem(db, row.id);
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
  const open = pendingPullComments(db, itemId);
  if (open.length === 0) return "done";
  const item = getWorkItem(db, itemId);
  if (item === null || ENDED.has(item.state) || item.cancelRequested) {
    settlePullComments(db, open, "dropped", caps.now());
    return "dropped";
  }
  if (settleCovered(db, open, caps.now()) === open.length) return "done";
  // A changes-requested review still waiting takes these comments with it.
  if (pendingChangeRequests(db, itemId).length > 0) return "wait";
  const pullNumber = open.at(-1)!.pullNumber;
  if (item.state === "merge_queue") {
    // Before waiting on anything: GitHub's own merge queue does not wait for Paws.
    const queue = await caps.leaveMergeQueue(item, pullNumber);
    if (queue === "merged" || queue === "closed") {
      settlePullComments(db, pendingPullComments(db, itemId), "dropped", caps.now());
      return "dropped";
    }
  }
  if (item.state !== "merge_queue" || caps.busy(item)) return "wait";
  const threads = await caps.threads(item, pullNumber);
  const findings = await caps.closeoutFindings(item);
  const step = immediate(db, (): PullReviewStep => {
    const current = getWorkItem(db, item.id);
    if (current === null || current.version !== item.version || current.state !== "merge_queue")
      return "wait";
    const now = caps.now();
    settleCovered(db, pendingPullComments(db, itemId), now);
    const batch = pendingPullComments(db, itemId);
    if (batch.length === 0) return "done";
    const digest = commentDigest(batch, threads);
    if (digest === null) {
      settlePullComments(db, batch, "dropped", now);
      return "dropped";
    }
    const rounds = fixRounds(db, current.id);
    const limit = caps.fixRoundLimit(current);
    if (rounds < limit) {
      const first = batch[0]!;
      const jobKey = `review:${current.id}:${first.source}:${first.commentId}`;
      const targets = replyTargets({ pullNumber, threads, reviews: [], comments: batch });
      const jobId = restart(db, current, {
        reason: "review",
        body: [
          digest,
          closeoutFindingsNote(findings, batch),
          COMMENT_FIX_INSTRUCTION,
          replyListSection(targets),
        ]
          .filter((part) => part !== "")
          .join("\n\n"),
        jobKey,
        now,
      });
      if (jobId === null) return "wait";
      postPullFeedback(db, {
        sessionId: caps.session(current),
        item: current,
        key: jobKey,
        body: `${authors(batch)} commented on pull request #${pullNumber}. The agent is working on the comments.`,
        now,
      });
      recordReplyTargets(db, current.id, jobKey, targets, now);
      if (current.acceptedHead !== null)
        recordReviewEscape(db, {
          triggerKey: jobKey,
          itemId: current.id,
          trigger: "comment",
          acceptedHead: current.acceptedHead,
          pullNumber,
          detail: {
            comments: batch
              .filter((comment) => comment.body.trim() !== "")
              .map((comment) => ({
                id: comment.commentId,
                author: comment.author,
                body: comment.body,
              })),
          },
          recordedAt: now,
        });
      settlePullComments(db, batch, "restarted", now);
      return "restarted";
    }
    const sessionId = caps.session(current);
    if (sessionId === null) {
      settlePullComments(db, batch, "dropped", now);
      return "dropped";
    }
    ask(
      db,
      { itemId: current.id, runId: current.currentRunId, sessionId, version: current.version },
      "ci-help",
      `${authors(batch)} commented on pull request #${pullNumber}, and all ${limit} fix rounds are spent. Reply with guidance and Paws hands it to the agent with the comments, or stop the task.\n\n${digest}`,
      { reason: "budget_spent", now },
    );
    settlePullComments(db, batch, "asked", now);
    return "asked";
  });
  if (step !== "wait" && step !== "done") await caps.flush();
  return step;
}

/** Inline comments of a changes-requested review reach the agent with that review. */
function settleCovered(db: Database, comments: readonly PullCommentRecord[], now: number): number {
  const covered = comments.filter(
    (comment) =>
      comment.source === "inline" &&
      comment.reviewId !== null &&
      getPullReview(db, comment.reviewId) !== null,
  );
  settlePullComments(db, covered, "covered", now);
  return covered.length;
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

function authors(comments: readonly PullCommentRecord[]): string {
  const names = [...new Set(comments.map((comment) => who(comment.author)))];
  return names.length <= 2 ? names.join(" and ") : `${names.slice(0, 2).join(", ")} and others`;
}

function who(author: string | null): string {
  return author ? `@${author}` : "Someone";
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
