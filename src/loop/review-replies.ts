import type { Database } from "bun:sqlite";
import {
  markReviewReplyPosted,
  recordReviewReplies,
  reportReviewReplies,
  unpostedReviewReplies,
  unreportedReviewReplies,
  type NewReviewReply,
  type PullCommentRecord,
  type PullReviewRecord,
  type ReviewReplyOutcome,
  type ReviewReplyRecord,
} from "../db";
import type { ReviewThread } from "../github";

/** Marks a comment Paws posted as a review reply, so it never comes back as a new comment. */
export const REVIEW_REPLY_MARKER = "<!-- paws-review-reply -->";

const EXCERPT_CHARS = 160;

/**
 * The comments one restart hands to the agent that each need a reply: the threads that belong to
 * these reviews and comments, the review bodies, and the conversation comments. Numbered from 1 in
 * the order the reviewer wrote them.
 */
export function replyTargets(input: {
  pullNumber: number;
  threads: readonly ReviewThread[];
  reviews: readonly Pick<PullReviewRecord, "reviewId" | "reviewer" | "body">[];
  comments: readonly PullCommentRecord[];
}): NewReviewReply[] {
  const reviewIds = new Set<number>([
    ...input.reviews.map((review) => review.reviewId),
    ...input.comments.flatMap((comment) =>
      comment.source !== "conversation" && comment.reviewId !== null ? [comment.reviewId] : [],
    ),
  ]);
  const inlineIds = new Set(
    input.comments.filter((comment) => comment.source === "inline").map((c) => c.commentId),
  );
  const targets: Omit<NewReviewReply, "number">[] = [];
  const answered = new Set<number>();
  for (const thread of input.threads) {
    const first = thread.comments[0];
    if (!first) continue;
    const belongs = thread.comments.some(
      (comment) =>
        (comment.reviewId !== null && reviewIds.has(comment.reviewId)) ||
        (comment.databaseId !== undefined && inlineIds.has(comment.databaseId)),
    );
    if (!belongs) continue;
    for (const comment of thread.comments)
      if (comment.databaseId !== undefined) answered.add(comment.databaseId);
    targets.push({
      pullNumber: input.pullNumber,
      target: "thread",
      commentId: first.databaseId ?? null,
      threadId: thread.id ?? null,
      author: first.author,
      excerpt: excerpt(
        `${thread.path ? `${thread.path}${thread.line === null ? "" : `:${thread.line}`}: ` : ""}${first.body}`,
      ),
    });
  }
  // An inline comment whose thread the read did not return is answered on its own.
  for (const comment of input.comments)
    if (comment.source === "inline" && !answered.has(comment.commentId))
      targets.push({
        pullNumber: input.pullNumber,
        target: "thread",
        commentId: comment.commentId,
        threadId: null,
        author: comment.author,
        excerpt: excerpt(
          `${comment.path ? `${comment.path}${comment.line === null ? "" : `:${comment.line}`}: ` : ""}${comment.body}`,
        ),
      });
  for (const review of input.reviews)
    if (review.body.trim() !== "")
      targets.push({
        pullNumber: input.pullNumber,
        target: "review",
        commentId: review.reviewId,
        threadId: null,
        author: review.reviewer,
        excerpt: excerpt(review.body),
      });
  for (const comment of input.comments)
    if ((comment.source === "review" || comment.source === "conversation") && comment.body.trim())
      targets.push({
        pullNumber: input.pullNumber,
        target: comment.source,
        commentId: comment.commentId,
        threadId: null,
        author: comment.author,
        excerpt: excerpt(comment.body),
      });
  return targets.map((target, index) => ({ ...target, number: index + 1 }));
}

/** The reply list the handoff ends with. Empty without targets. */
export function replyListSection(targets: readonly NewReviewReply[]): string {
  if (targets.length === 0) return "";
  return [
    "Reply list. Paws replies to each entry on the pull request after Closeout accepts your fix, and resolves the threads you fixed or answered. Do not reply or resolve on GitHub yourself. End your final message with a `Review replies` section that has one line for every entry, in this form:",
    "R1 fixed: what you changed",
    "R2 answered: your answer to a question or note",
    "R3 not changed: why you left it, for the reviewer to decide",
    "",
    ...targets.map(
      (target) =>
        `R${target.number}. ${target.target === "thread" ? "Thread" : target.target === "review" ? "Review" : "Comment"} by ${target.author ? `@${target.author}` : "someone"}: ${target.excerpt}`,
    ),
  ].join("\n");
}

/** Record the reply targets of the restart with job key `restartKey`. Call inside its transaction. */
export function recordReplyTargets(
  db: Database,
  itemId: string,
  restartKey: string,
  targets: readonly NewReviewReply[],
  now: number,
): void {
  recordReviewReplies(db, { itemId, restartKey, replies: targets, now });
}

const LINE =
  /^[\s>*_-]*\**R(\d{1,3})\**[.:)]?\s*\**(fixed|answered|not[\s_-]?changed|declined|won't fix|wont fix)\**\s*[:.–—-]\s*(.+)$/i;

/** The `R<n> <outcome>: <reply>` lines of an agent's final message, by entry number. */
export function parseReviewReplies(
  text: string,
): Map<number, { outcome: Exclude<ReviewReplyOutcome, "unreported">; reply: string }> {
  const reports = new Map<
    number,
    { outcome: Exclude<ReviewReplyOutcome, "unreported">; reply: string }
  >();
  for (const line of text.split("\n")) {
    const match = LINE.exec(line.trim());
    if (!match) continue;
    const word = match[2]!.toLowerCase();
    const outcome = word === "fixed" ? "fixed" : word === "answered" ? "answered" : "not_changed";
    const reply = match[3]!.trim();
    if (reply !== "") reports.set(Number(match[1]), { outcome, reply });
  }
  return reports;
}

/**
 * Store the fix turn's replies for the item's handed-off comments. Does nothing when no comments
 * wait for a report. The number stored.
 */
export function recordAgentReviewReplies(
  db: Database,
  itemId: string,
  finalMessage: string,
  now: number,
): number {
  if (unreportedReviewReplies(db, itemId).length === 0) return 0;
  return reportReviewReplies(db, itemId, parseReviewReplies(finalMessage), now);
}

export type ReviewReplyGitHub = {
  replyToReviewComment(prNumber: number, commentId: number, body: string): Promise<void>;
  commentOnPullRequest(prNumber: number, body: string): Promise<void>;
  resolveReviewThread(threadId: string): Promise<void>;
};

/**
 * Post every reported reply on pull request `pullNumber`, once each, and resolve the threads the
 * fix addressed. A reply that fails stays unposted for the next publication. The number posted.
 */
export async function postReviewReplies(
  db: Database,
  input: { itemId: string; pullNumber: number; head: string; now: () => number },
  github: ReviewReplyGitHub,
): Promise<number> {
  let posted = 0;
  for (const reply of unpostedReviewReplies(db, input.itemId, input.pullNumber)) {
    const body = replyBody(reply, input.head);
    if (reply.target === "thread" && reply.commentId !== null)
      await github.replyToReviewComment(input.pullNumber, reply.commentId, body);
    else await github.commentOnPullRequest(input.pullNumber, quoted(reply, body));
    const resolve =
      reply.target === "thread" &&
      reply.threadId !== null &&
      (reply.outcome === "fixed" || reply.outcome === "answered");
    if (resolve) await github.resolveReviewThread(reply.threadId!);
    markReviewReplyPosted(db, reply.id, input.now(), resolve);
    posted += 1;
  }
  return posted;
}

function replyBody(reply: ReviewReplyRecord, head: string): string {
  const text = reply.reply?.trim() ?? "";
  const lead =
    reply.outcome === "fixed"
      ? `**Fixed** in ${head.slice(0, 7)}. ${text}`
      : reply.outcome === "answered"
        ? text
        : reply.outcome === "not_changed"
          ? `**Not changed.** ${text}`
          : "Paws gave this comment to the agent, but the agent did not report on it. Leaving it open for a reviewer.";
  return `${lead.trim()}\n\n${REVIEW_REPLY_MARKER}`;
}

function quoted(reply: ReviewReplyRecord, body: string): string {
  const who = reply.author ? `@${reply.author}` : "Reviewer";
  return `> ${who}: ${reply.excerpt}\n\n${body}`;
}

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS - 1)}…`;
}
