import { askSteps, restartSteps } from "./operations";
import { askWithLinkSteps, linkAskAvailable } from "./link-ask";
import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { EvidenceApproval, ResolvedEvidence } from "../closeout";
import { readEvidenceBytes, type EvidenceStorage } from "../evidence";
import { JOB_KIND } from "../core";
import {
  setQuestionHandoffVersionSteps,
  type LinkAsk,
  type WorkItemRecord,
  applyWorkItemEventSteps,
  closeLinkAskSteps,
  enqueueJobOnceSteps,
  enqueueOutboxOnceSteps,
  getEvidenceSteps,
  getLinkAskSteps,
  getWorkItemSteps,
  linearConversationUrlAsync,
  latestEvidence,
  listEvidenceSteps,
  listVisualReviewMarksSteps,
  listVisualReviewsSteps,
  saveCheckpointSteps,
  saveVisualReviewMarksSteps,
  sqliteDb,
  type Db,
  type Q,
  type Steps,
  type StoredEvidence,
  type VisualReviewMark,
} from "../db";
import { reviewMarkPath } from "./input-files";
import { compareScreenshots } from "./screenshot-diff";
import {
  acceptedVisualReviewsSteps,
  approvalTime,
  carriedInFull,
  humanApprovedScreensSteps,
  recordCarriedVisualReviewSteps,
  visualReviewCarriedNote,
  type VisualReviewCarry,
  cancelQuestionSteps,
  findOpenQuestionSteps,
  getQuestionSteps,
  getVisualReviewSteps,
  insertVisualReviewSteps,
  lastVisualReviewFeedbackSteps,
  openVisualReviewContinueSteps,
  parseVisualReviewAnswer,
  recordVisualReviewAnswerSteps,
  rejectedEvidenceIdsSteps,
  removeLinkAskUrlSteps,
  shortCommit,
  visualReviewAcceptedHandoff,
  visualReviewChangesHandoff,
  visualReviewLinkDetail,
  visualReviewRoundsSteps,
  VISUAL_REVIEW_ROUNDS,
  type StoredQuestion,
  type StoredVisualReview,
  VISUAL_REVIEW_REMINDER,
} from "../questions";

type DueReview = { requirement: ResolvedEvidence; evidenceIds: string[] } | null;

export function* dueVisualReviewSteps(
  q: Q,
  itemId: string,
  requirements: readonly ResolvedEvidence[],
  approvals: readonly EvidenceApproval[],
): Steps<DueReview> {
  const rejected = yield* rejectedEvidenceIdsSteps(q, itemId);
  const evidence = latestEvidence(yield* listEvidenceSteps(q, itemId));
  for (const requirement of requirements) {
    const evidenceIds = evidence
      .filter(
        (row) =>
          row.checkId === requirement.id &&
          !rejected.has(row.id) &&
          requirement.media.includes(row.mediaType.startsWith("video/") ? "video" : "image"),
      )
      .map((row) => row.id);
    if (evidenceIds.length < requirement.minimum) continue;
    const covered = approvals.some(
      (approval) =>
        approval.checkId === requirement.id &&
        evidenceIds.every((id) => approval.evidenceIds.includes(id)),
    );
    if (!covered) return { requirement, evidenceIds };
  }
  return null;
}

/** What happens to each file due for review. */
export type VisualReviewCarryPlan = {
  /** Files that look the same as one a person accepted. */
  carried: VisualReviewCarry[];
  /** Changed files with the approved version to show beside them. */
  approved: Map<string, string>;
};

/**
 * Matches each file to the latest file a person accepted with the same check
 * and display name. Same bytes, or pixels within tolerance, carry the
 * approval over. A changed file keeps its approved version for the question.
 * A file with no accepted predecessor is asked. Reads files, so call outside a transaction.
 */
export async function planVisualReviewCarry(
  db: Database,
  itemId: string,
  checkId: string,
  evidenceIds: readonly string[],
  storage: EvidenceStorage | undefined,
): Promise<VisualReviewCarryPlan> {
  const plan: VisualReviewCarryPlan = { carried: [], approved: new Map() };
  const store = sqliteDb(db);
  const origins = await store.run((q) => humanApprovedScreensSteps(q, itemId, checkId));
  const approved: ((typeof origins)[number] & { row: StoredEvidence })[] = [];
  for (const origin of origins) {
    const row = await store.run((q) => getEvidenceSteps(q, origin.fromEvidenceId));
    if (row) approved.push({ ...origin, row });
  }
  for (const id of evidenceIds) {
    const row = await store.run((q) => getEvidenceSteps(q, id));
    if (row === null) continue;
    const before = approved.findLast(
      (entry) => entry.row.displayName === row.displayName && entry.row.checkId === row.checkId,
    );
    if (before === undefined) continue;
    const { row: seen, ...origin } = before;
    if (seen.sha256 === row.sha256) {
      plan.carried.push({ ...origin, evidenceId: id, match: "identical" });
      continue;
    }
    if (
      storage !== undefined &&
      seen.mediaType.startsWith("image/") &&
      row.mediaType.startsWith("image/") &&
      (await looksTheSame(db, storage, seen.id, row.id))
    ) {
      plan.carried.push({ ...origin, evidenceId: id, match: "similar" });
      continue;
    }
    plan.approved.set(id, seen.id);
  }
  return plan;
}

async function looksTheSame(
  db: Database,
  storage: EvidenceStorage,
  before: string,
  after: string,
): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([
      readEvidenceBytes(db, storage, before),
      readEvidenceBytes(db, storage, after),
    ]);
    return (await compareScreenshots(a, b))?.same === true;
  } catch (caughtError1) {
    journalCaught(caughtError1, "visual-review.looksTheSame.all", null);
    return false;
  }
}

/**
 * Every file due for review carried an approval over: records the accepted
 * review without a question and posts one line to Linear. Call inside a transaction.
 */
type CarryInput = {
  item: WorkItemRecord;
  sessionId: string;
  checkId: string;
  evidenceIds: readonly string[];
  carried: readonly VisualReviewCarry[];
  head: string;
  now: number;
};

export function* carryVisualReviewSteps(q: Q, input: CarryInput): Steps<StoredVisualReview> {
  const review = yield* recordCarriedVisualReviewSteps(q, {
    itemId: input.item.id,
    checkId: input.checkId,
    evidenceIds: input.evidenceIds,
    carried: input.carried,
    headCommit: input.head,
    now: input.now,
  });
  const approvedAt = Math.max(...input.carried.map((entry) => entry.approvedAt));
  yield* postNoteSteps(
    q,
    input.sessionId,
    input.item,
    visualReviewCarriedNote(approvedAt, input.now),
    `visual-review-carried:${review.questionId}`,
    input.now,
  );
  return review;
}

/**
 * The open review question of the item's pending-human check: a link ask
 * answered on the item page, or an older Linear question with options.
 */
type PendingReview = { question: StoredQuestion; review: StoredVisualReview } | null;

export function* pendingVisualReviewSteps(q: Q, item: WorkItemRecord): Steps<PendingReview> {
  if (item.sessionKey === null) return null;
  const question = yield* findOpenQuestionSteps(q, item.sessionKey);
  if (question?.itemId !== item.id) return null;
  if (question.kind !== "visual-review" && question.kind !== "link") return null;
  const review = yield* getVisualReviewSteps(q, question.id);
  return review?.kind === "review" ? { question, review } : null;
}

/** Cancels the open review question, and closes its link ask and takes the link off the session. */
export function* cancelVisualReviewQuestionSteps(
  q: Q,
  questionId: string,
  reason: "head_moved" | "cancelled",
  now: number,
): Steps<void> {
  yield* cancelQuestionSteps(q, questionId, now);
  if ((yield* getLinkAskSteps(q, questionId))?.closedAt !== null) return;
  yield* closeLinkAskSteps(q, questionId, { reason, now });
  yield* removeLinkAskUrlSteps(q, questionId, now);
}

/** A pending-human check opens while the item is verifying head S. */
export function reviewable(item: WorkItemRecord | null): item is WorkItemRecord {
  return item?.state === "verifying" && !item.cancelRequested;
}

/**
 * Asks the delegator or the project lead to approve the screens on the item
 * page, where they are in view: the screenshots link ask. A Linear reply only
 * ever requests changes. Without an https dashboard link nobody could see the
 * screens, so Paws does not ask and the check stays unapproved; it says so once.
 * Returns whether it asked.
 */
type AskForReview = {
  item: WorkItemRecord;
  runId: string | null;
  sessionId: string;
  checkId: string;
  evidenceIds: readonly string[];
  base: string;
  head: string;
  publicUrl: string;
  now: number;
  /** Files among `evidenceIds` that carried an approval over and are not asked about. */
  carried?: readonly VisualReviewCarry[];
};

export function* askForVisualReviewSteps(q: Q, input: AskForReview): Steps<boolean> {
  const { item, sessionId } = input;
  const carried = input.carried ?? [];
  const current = yield* getWorkItemSteps(q, item.id);
  if (!reviewable(current)) return false;
  if ((yield* findOpenQuestionSteps(q, sessionId)) !== null) return false;
  if (!linkAskAvailable(input.publicUrl) || current.sessionKey !== sessionId) {
    yield* postNoteSteps(
      q,
      sessionId,
      current,
      VISUAL_REVIEW_NEEDS_LINK,
      `visual-review-needs-link:${item.id}:${input.head}`,
      input.now,
    );
    return false;
  }
  const skipped = new Set(carried.map((entry) => entry.evidenceId));
  const names = new Map<string, string>();
  for (const id of input.evidenceIds)
    names.set(id, (yield* getEvidenceSteps(q, id))?.displayName ?? id);
  const name = (id: string) => names.get(id) ?? id;
  const { question } = yield* askWithLinkSteps(q, {
    item: current,
    runId: input.runId,
    kind: "screenshots",
    head: input.head,
    detail: visualReviewLinkDetail(
      input.checkId,
      input.evidenceIds.filter((id) => !skipped.has(id)).map(name),
      carried.map((entry) => name(entry.evidenceId)),
    ),
    publicUrl: input.publicUrl,
    now: input.now,
    // Asked beside the command checks and the review; the item stays verifying.
    pending: true,
  });
  yield* insertVisualReviewSteps(q, {
    questionId: question.id,
    itemId: item.id,
    checkId: input.checkId,
    evidenceIds: input.evidenceIds,
    headCommit: input.head,
    now: input.now,
    carried,
  });
  return true;
}

/** Why a localhost-only Paws leaves a human visual review unapproved. */
export const VISUAL_REVIEW_NEEDS_LINK =
  "Visual review needs a dashboard link a person can open, so the screens can be approved where they are in view. Set PAWS_PUBLIC_URL to an https address; a reply in Linear cannot approve screens.";

/** Posts the one reminder while the review is still open and the task still waits on it. */
export async function remindVisualReview(
  db: Database,
  questionId: string,
  now: number,
): Promise<boolean> {
  const store = sqliteDb(db);
  const question = await store.run((q) => getQuestionSteps(q, questionId));
  if (
    question === null ||
    question.status !== "open" ||
    !(await store.run((q) => getVisualReviewSteps(q, questionId)))
  )
    return false;
  const item = await store.run((q) => getWorkItemSteps(q, question.itemId));
  if (item === null || item.state !== "awaiting_input" || item.cancelRequested) return false;
  await store.transaction((q) =>
    enqueueOutboxOnceSteps(q, {
      target: "linear",
      op: "elicitation",
      orderingKey: question.sessionId,
      idempotencyKey: `visual-review-reminder:${questionId}`,
      payload: {
        id: randomUUID(),
        sessionId: question.sessionId,
        questionId,
        body: VISUAL_REVIEW_REMINDER,
        options: [],
      },
      now,
    }),
  );
  return true;
}

/** A thought on the session while the task waits, when progress posts are held back. */
export function* postNoteSteps(
  q: Q,
  sessionId: string,
  item: WorkItemRecord,
  body: string,
  key: string,
  now: number,
): Steps<void> {
  yield* enqueueOutboxOnceSteps(q, {
    target: "linear",
    op: "activity",
    orderingKey: sessionId,
    idempotencyKey: key,
    delivery: "critical",
    payload: {
      id: randomUUID(),
      sessionId,
      itemId: item.id,
      issueId: item.linearIssueId,
      kind: "thought",
      body,
    },
    now,
  });
}

/**
 * Records a Linear answer to a review question asked before the link ask.
 * A reply in Linear never approves screens: every answer, "Accept" included,
 * is a change request, and Keep going after the round limit goes back to the
 * agent. Moves no state: the caller does.
 */
export function* recordVisualReviewOutcomeSteps(
  q: Q,
  question: StoredQuestion,
  review: StoredVisualReview,
  now: number,
): Steps<"changes" | "asked"> {
  const answer = question.answer ?? "";
  const answeredBy = question.answeredBy ?? "";
  if (review.kind === "continue") {
    const extra = /^keep going[.!]?$/i.test(answer.trim()) ? undefined : answer.trim();
    yield* recordVisualReviewAnswerSteps(q, question.id, {
      outcome: "continued",
      answeredBy,
      now,
      ...(extra ? { feedback: extra } : {}),
    });
    return "changes";
  }
  const parsed = parseVisualReviewAnswer(answer);
  yield* recordVisualReviewAnswerSteps(q, question.id, {
    outcome: "changes_requested",
    answeredBy,
    now,
    feedback: parsed.kind === "changes" ? parsed.feedback : answer.trim(),
  });
  if ((yield* visualReviewRoundsSteps(q, question.itemId, review.checkId)) < VISUAL_REVIEW_ROUNDS)
    return "changes";
  yield* openVisualReviewContinueSteps(q, {
    ask: askSteps,
    itemId: question.itemId,
    runId: question.runId,
    sessionId: question.sessionId,
    checkId: review.checkId,
    now,
  });
  return "asked";
}

/** What Paws posts when a Linear reply on the screenshots link ask became a change request. */
export const VISUAL_REVIEW_REPLY_NOTE =
  "Sent your reply to the agent as the changes you want. A reply in Linear never approves the screens; approve them in Paws.";

/**
 * A decision on the screenshots link ask, inside its transaction, after the
 * question is answered. `approve` comes only from the item page and passes
 * the check for the ask's head and files. `changes` comes from the page, with
 * the drawn marks, or from a Linear reply. Returns false when the ask has no
 * visual review, so the caller hands the decision back as usual.
 */
export function* decideVisualReviewSteps(
  q: Q,
  input: {
    linkAsk: LinkAsk;
    decision: "approve" | "changes";
    feedback: string;
    answeredBy: string;
    marks?: readonly VisualReviewMark[];
    now: number;
  },
  notifications: { ready: boolean },
): Steps<boolean> {
  const { linkAsk, now } = input;
  const review = yield* getVisualReviewSteps(q, linkAsk.questionId);
  const question = yield* getQuestionSteps(q, linkAsk.questionId);
  if (review?.kind !== "review" || question === null) return false;
  if (input.decision === "approve") {
    yield* recordVisualReviewAnswerSteps(q, review.questionId, {
      outcome: "accepted",
      answeredBy: input.answeredBy,
      headCommit: linkAsk.headCommit,
      now,
    });
    const item = yield* getWorkItemSteps(q, review.itemId);
    // While the other checks still run on S, that evaluation picks the approval up.
    if (
      item?.state !== "awaiting_input" ||
      (yield* findOpenQuestionSteps(q, question.sessionId)) !== null
    )
      return true;
    yield* applyWorkItemEventSteps(q, item.id, "reverify_requested", { now });
    if (item.checkpoint)
      yield* saveCheckpointSteps(q, item.id, { ...item.checkpoint, phase: "verifying" });
    const { inserted } = yield* enqueueJobOnceSteps(q, {
      queue: JOB_KIND.reverify,
      jobKey: `visual-review-accepted:${review.questionId}`,
      payload: { itemId: item.id, decide: true },
      now,
    });
    if (inserted) notifications.ready = true;
    return true;
  }
  if (input.marks?.length) yield* saveVisualReviewMarksSteps(q, input.marks);
  yield* recordVisualReviewAnswerSteps(q, review.questionId, {
    outcome: "changes_requested",
    answeredBy: input.answeredBy,
    feedback: input.feedback,
    headCommit: linkAsk.headCommit,
    now,
  });
  if ((yield* visualReviewRoundsSteps(q, review.itemId, review.checkId)) >= VISUAL_REVIEW_ROUNDS) {
    yield* openVisualReviewContinueSteps(q, {
      ask: askSteps,
      itemId: review.itemId,
      runId: question.runId,
      sessionId: question.sessionId,
      checkId: review.checkId,
      now,
    });
    return true;
  }
  const item = yield* getWorkItemSteps(q, review.itemId);
  if (item === null) return true;
  const restarted = yield* restartSteps(q, item, {
    reason: "review",
    body: (yield* visualReviewHandoffSteps(q, review.questionId)) ?? "",
    jobKey: `resume:answer:${review.questionId}`,
    now,
  });
  if (restarted?.armed) notifications.ready = true;
  if (restarted !== null)
    yield* setQuestionHandoffVersionSteps(
      q,
      review.questionId,
      (yield* getWorkItemSteps(q, item.id))!.version,
    );
  return true;
}

export function* visualReviewHandoffSteps(q: Q, questionId: string): Steps<string | null> {
  const review = yield* getVisualReviewSteps(q, questionId);
  if (review === null) return null;
  if (review.outcome === "accepted") return visualReviewAcceptedHandoff(review.checkId);
  if (review.outcome === "changes_requested")
    return visualReviewChangesHandoff(
      review.checkId,
      review.feedback ?? "",
      yield* markedFilesSteps(q, review.itemId, questionId),
    );
  if (review.outcome === "continued") {
    const last = yield* lastVisualReviewFeedbackSteps(q, review.itemId, review.checkId);
    const feedback = last?.feedback ?? "";
    return visualReviewChangesHandoff(
      review.checkId,
      review.feedback ? `${feedback}\n\n${review.feedback}` : feedback,
      last ? yield* markedFilesSteps(q, review.itemId, last.questionId) : [],
    );
  }
  return null;
}

function* markedFilesSteps(q: Q, itemId: string, questionId: string) {
  const evidence = new Map((yield* listEvidenceSteps(q, itemId)).map((row) => [row.id, row]));
  return (yield* listVisualReviewMarksSteps(q, questionId)).flatMap((mark) => {
    const row = evidence.get(mark.evidenceId);
    return row
      ? [
          {
            path: reviewMarkPath(mark.id),
            displayName: row.displayName,
            evidenceId: row.id,
            headCommit: row.headCommit,
          },
        ]
      : [];
  });
}

export function* visualReviewApprovalsSteps(
  q: Q,
  itemId: string,
  task: string,
): Steps<EvidenceApproval[]> {
  return (yield* acceptedVisualReviewsSteps(q, itemId)).map((review) => ({
    task,
    checkId: review.checkId,
    evidenceIds: review.evidenceIds,
    approvedBy: review.answeredBy ?? "",
    approvedAt: new Date(review.answeredAt ?? review.createdAt).toISOString(),
    ...(review.headCommit ? { commit: review.headCommit } : {}),
  }));
}

export async function visualReviewPullRequestNote(
  store: Db,
  item: WorkItemRecord,
  publicUrl: string | null,
  now: number = Date.now(),
): Promise<string> {
  const accepted = (await store.run((q) => listVisualReviewsSteps(q, item.id))).filter(
    (review) => review.outcome === "accepted",
  );
  if (accepted.length === 0) return "";
  const evidence = await store.run((q) => listEvidenceSteps(q, item.id));
  const question = await linearConversationUrlAsync(store, item.sessionKey, item.linearIdentifier);
  const linkAsked = new Set<string>();
  for (const review of accepted)
    if (
      !carriedInFull(review) &&
      (await store.run((q) => getLinkAskSteps(q, review.questionId))) !== null
    )
      linkAsked.add(review.questionId);
  const base = publicUrl?.replace(/\/+$/, "");
  const names = new Map(evidence.map((row) => [row.id, row.displayName]));
  return accepted
    .map((review) => {
      const full = carriedInFull(review);
      const origins = [
        ...new Map(review.carried.map((entry) => [entry.approvalId, entry])).values(),
      ];
      const carried = origins.map((origin) => {
        const screens = review.carried
          .filter((entry) => entry.approvalId === origin.approvalId)
          .map((entry) => names.get(entry.evidenceId) ?? entry.evidenceId);
        return `${full ? "Visual review carried over" : "Carried over"} from the approval by ${origin.approvedBy} at ${approvalTime(origin.approvedAt, now)} (approval ${origin.approvalId}), unchanged since: ${screens.join(", ")}.`;
      });
      return [
        ...(full
          ? []
          : [
              !linkAsked.has(review.questionId)
                ? `Visual review accepted by ${review.answeredBy ?? "a reviewer"} in [Linear](<${question}>).`
                : `Visual review accepted by ${review.answeredBy ?? "a reviewer"} in Paws for ${shortCommit(review.headCommit ?? "")}.`,
            ]),
        ...carried,
        ...latestEvidence(evidence.filter((row) => review.evidenceIds.includes(row.id))).flatMap(
          (row) => {
            const label = row.displayName.replace(/[\\[\]]/g, "\\$&");
            const url =
              row.assetUrl || (base ? `${base}/evidence/${encodeURIComponent(row.id)}` : null);
            if (!url) return [];
            return [
              `${row.assetUrl && row.mediaType.startsWith("image/") ? "!" : ""}[${label}](<${url}>)`,
            ];
          },
        ),
      ].join("\n\n");
    })
    .join("\n\n");
}
