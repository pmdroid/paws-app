import type { Database } from "bun:sqlite";
import {
  emitJobReady,
  markReviewReplyPostedSteps,
  recordReviewReplies,
  getRunSteps,
  getWorkItemSteps,
  markRunSteps,
  reportReviewRepliesSteps,
  restartsSinceHumanTurnSteps,
  unpostedReviewRepliesSteps,
  unreportedReviewRepliesSteps,
  type Db,
  type Q,
  type Steps,
  type NewReviewReply,
  type PullCommentRecord,
  type PullReviewRecord,
  type ReviewReplyOutcome,
  type ReviewReplyRecord,
  type WorkItemRecord,
} from "../db";
import type { ReviewThread } from "../github";
import { askSteps, restartSteps } from "./operations";

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
    "Reply list. Paws replies to each entry on the pull request after Closeout accepts your fix, and resolves only the threads you fixed. Threads answered without a code change stay open for the reviewer. Do not reply or resolve on GitHub yourself. End your final message with a `Review replies` section that has one line for every entry, in this form:",
    "R1 fixed: what you changed",
    "R2 not changed: your answer to a question or note",
    "R3 not changed: why you left it, for the reviewer to decide",
    EACH_ENTRY,
    "",
    ...targets.map(entryLine),
  ].join("\n");
}

const EACH_ENTRY =
  "Answer each comment in its own entry. A summary saying you fixed everything is not a reply, and Paws does not accept your turn until every entry has its own.";

function entryLine(target: NewReviewReply): string {
  return `R${target.number}. ${target.target === "thread" ? "Thread" : target.target === "review" ? "Review" : "Comment"} by ${target.author ? `@${target.author}` : "someone"}: ${target.excerpt}`;
}

/** Send-backs for missing replies in one round before Paws asks the team instead. */
export const REPLY_SEND_BACKS = 2;

/**
 * Check a fix turn's `Review replies` against its reply list before Closeout runs. `complete`
 * stores the replies and goes on. With an entry missing or without text, the reported replies are
 * stored, and the item goes back to the same session with the missing entries (`sent_back`, no fix
 * round spent), or after {@link REPLY_SEND_BACKS} in the round the team is asked and the run ends
 * (`asked`). One transaction: the stored replies and the send-back or question commit together.
 */
type ReplyCheck = {
  item: WorkItemRecord;
  runId: string;
  sessionId: string | null;
  finalMessage: string;
  now: number;
};

export async function checkReviewReplies(
  store: Db,
  input: ReplyCheck,
): Promise<"complete" | "sent_back" | "asked" | "stale"> {
  const { item } = input;
  // Most turn ends have no reply list: skip the write transaction for them.
  if ((await store.run((q) => unreportedReviewRepliesSteps(q, item.id))).length === 0)
    return "complete";
  try {
    const checked = await store.transaction((q) => checkOpenRepliesSteps(q, input));
    if (checked.armed) emitJobReady(store);
    return checked.outcome;
  } catch (error) {
    if (error instanceof StaleTurnEnd) return "stale";
    throw error;
  }
}

/** Another writer moved the item on while the turn ended; nothing of this check is kept. */
class StaleTurnEnd extends Error {}

function* checkOpenRepliesSteps(
  q: Q,
  input: ReplyCheck,
): Steps<{ outcome: "complete" | "sent_back" | "asked"; armed: boolean }> {
  const { item, now } = input;
  const current = yield* getWorkItemSteps(q, item.id);
  if (current?.version !== item.version) throw new StaleTurnEnd();
  const open = yield* unreportedReviewRepliesSteps(q, item.id);
  if (open.length === 0) return { outcome: "complete", armed: false };
  const reports = parseReviewReplies(input.finalMessage);
  const missing = open.filter((reply) => !reports.has(reply.number));
  const complete = missing.length === 0 || input.sessionId === null;
  yield* reportReviewRepliesSteps(q, item.id, reports, now, !complete);
  if (complete) return { outcome: "complete", armed: false };
  // The round is the restart that handed off the open entries. A later handoff deletes the open
  // entries of earlier ones, so they share it; the newest row decides should that ever change.
  const round = open.reduce((a, b) => (b.id > a.id ? b : a)).restartKey;
  const prefix = `review-replies:${round}:`;
  const sent = yield* restartsSinceHumanTurnSteps(q, item.id, prefix);
  const list = missing.map(entryLine).join("\n");
  if (sent < REPLY_SEND_BACKS) {
    // restart() ends the run; the next turn resumes the same session. Null: the merge lane owns
    // the item, so roll back the stored replies too.
    const job = yield* restartSteps(q, item, {
      reason: "follow_up",
      body: `Your turn ended without a reply to every entry of the reply list. ${EACH_ENTRY} End your final message with a \`Review replies\` section that answers these entries, one line each, as \`R<n> fixed: …\` or \`R<n> not changed: …\`:\n\n${list}`,
      jobKey: `${prefix}${item.version}`,
      now,
    });
    if (job === null) throw new StaleTurnEnd();
    return { outcome: "sent_back", armed: job.armed };
  }
  yield* askSteps(
    q,
    { itemId: item.id, runId: input.runId, sessionId: input.sessionId!, version: item.version },
    "agent",
    `The agent ended its fix turn ${sent + 1} times without its own reply to every pull request comment it was given, so Closeout has not started. Still without a reply:\n\n${list}\n\nTell the agent how to answer them.`,
    { now },
  );
  if ((yield* getRunSteps(q, input.runId))?.status === "active")
    yield* markRunSteps(q, input.runId, "ended", now);
  return { outcome: "asked", armed: false };
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
    // A reply of only markup (`R2 fixed: **`) is no reply; a letter, digit or emoji is.
    if (/[\p{L}\p{N}\p{So}]/u.test(reply)) reports.set(Number(match[1]), { outcome, reply });
  }
  return reports;
}

const DECISION_LINE =
  /^[*_-]*\s*\**(F[0-9a-f]{6})\**[.:)]?\s*\**(fixed|declined|not[\s_-]?changed|won't fix|wont fix)\**\s*[:.–—-]\s*(.+)$/i;
const DECISION_HEADING = /^(#{1,6}\s*)?[*_]*finding decisions[*_]*:?[*_]*$/i;

export function parseFindingDecisions(
  text: string,
  ids: ReadonlySet<string>,
): Map<string, { decision: "fixed" | "declined"; reason: string }> {
  const decisions = new Map<string, { decision: "fixed" | "declined"; reason: string }>();
  const lines = text.split("\n").map((line) => line.trim());
  const heading = lines.findLastIndex((line) => DECISION_HEADING.test(line));
  if (heading === -1) return decisions;
  for (const line of lines.slice(heading + 1)) {
    if (line === "") continue;
    const match = DECISION_LINE.exec(line);
    if (!match) break;
    const id = `F${match[1]!.slice(1).toLowerCase()}`;
    const reason = match[3]!.trim();
    if (!ids.has(id) || reason === "") continue;
    decisions.set(id, {
      decision: match[2]!.toLowerCase() === "fixed" ? "fixed" : "declined",
      reason,
    });
  }
  return decisions;
}

export type ReviewReplyGitHub = {
  replyToReviewComment(prNumber: number, commentId: number, body: string): Promise<void>;
  commentOnPullRequest(prNumber: number, body: string): Promise<void>;
  resolveReviewThread(threadId: string): Promise<void>;
};

/**
 * Post every reported reply on pull request `pullNumber`, once each, and resolve the threads the
 * agent fixed. Failed replies stay unposted; failed resolutions leave threads open.
 * Process every row before reporting errors. Return the number of replies posted.
 */
export async function postReviewReplies(
  store: Db,
  input: { itemId: string; pullNumber: number; head: string; now: () => number },
  github: ReviewReplyGitHub,
): Promise<number> {
  let posted = 0;
  const errors: unknown[] = [];
  const replies = await store.run((q) =>
    unpostedReviewRepliesSteps(q, input.itemId, input.pullNumber),
  );
  for (const reply of replies) {
    try {
      const body = replyBody(reply, input.head);
      if (reply.target === "thread" && reply.commentId !== null)
        await github.replyToReviewComment(input.pullNumber, reply.commentId, body);
      else await github.commentOnPullRequest(input.pullNumber, quoted(reply, body));
      await store.run((q) => markReviewReplyPostedSteps(q, reply.id, input.now(), false));
      posted += 1;
      if (reply.target === "thread" && reply.threadId !== null && reply.outcome === "fixed") {
        await github.resolveReviewThread(reply.threadId);
        await store.run((q) => markReviewReplyPostedSteps(q, reply.id, input.now(), true));
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "GitHub review replies failed");
  return posted;
}

function replyBody(reply: ReviewReplyRecord, head: string): string {
  const text = reply.reply?.trim() ?? "";
  const lead =
    reply.outcome === "fixed"
      ? `**Fixed** in ${head.slice(0, 7)}. ${text}`
      : reply.outcome === "answered"
        ? `**Answered.** ${text}`
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
