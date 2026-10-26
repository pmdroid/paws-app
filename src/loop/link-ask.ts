import { ask, restart } from "./operations";
import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  applyLinearTurns,
  applyWorkItemEvent,
  approveCloseoutBypassChecks,
  auditWorkspaceAccess,
  closeLinkAsk,
  delegatedLinearUserId,
  enqueueJobOnce,
  enqueueOutboxOnce,
  failWorkItem,
  getLinkAsk,
  getWorkItem,
  immediate,
  listCloseoutBypassChecks,
  listCloseoutRecoveries,
  LINK_ASK_DECISIONS,
  LINK_ASK_NOTE_REQUIRED,
  openLinkAsks,
  recordLinkAskDecision,
  saveCheckpoint,
  type LinkAsk,
  type LinkAskDecision,
  type LinkAskKind,
  type VisualReviewMark,
  type LinkAskRounds,
  type WorkItemRecord,
} from "../db";
import {
  answerQuestion,
  canAnswer,
  cancelQuestion,
  getQuestion,
  LINK_ASK_ANCHORS,
  LINK_ASK_REMINDER_MS,
  linkAskDecidedNote,
  linkAskHandoff,
  linkAskReminderBody,
  openLinkAsk,
  removeLinkAskUrl,
  shortCommit,
  type StoredQuestion,
} from "../questions";
import { projectLeadId } from "../scheduler";
import { BYPASS_REPLY } from "./closeout-recovery";
import { worktreeBranch } from "./sources";
import { decideVisualReview, postNote, VISUAL_REVIEW_REPLY_NOTE } from "./visual-review";

/** A Paws that only listens on localhost has no link a person can open, so it cannot ask this way. */
export const LINK_ASK_NEEDS_PUBLIC_URL =
  "Asking with a link needs a dashboard link a person can open. Set PAWS_PUBLIC_URL.";

export const LINK_ASK_GUIDANCE_NOTE =
  "Sent your reply to the agent as guidance. A reply in Linear decides nothing; Paws asks again on the next commit.";

/** What Paws posts when a reply in Linear answers a rounds ask. */
export const REVIEW_ROUNDS_REPLY_NOTE =
  "Sent your reply to the agent: it rethinks the approach with the open findings and a new round budget.";

const ENDED = new Set(["cancelled", "merged", "failed", "completed"]);

/** Whether this Paws can hand out a link the delegator can open. */
export function linkAskAvailable(publicUrl: string | null | undefined): publicUrl is string {
  return typeof publicUrl === "string" && publicUrl.startsWith("https://");
}

/** `https://paws.example/status/issues/PAS-633#closeout` */
export function linkAskUrl(publicUrl: string, item: WorkItemRecord, kind: LinkAskKind): string {
  const issue = encodeURIComponent(item.linearIdentifier ?? item.id);
  return `${publicUrl.replace(/\/+$/, "")}/status/issues/${issue}#${LINK_ASK_ANCHORS[kind]}`;
}

/**
 * Asks the delegator or the project lead for a decision on the item page:
 * one elicitation with a Markdown body and no options, the link on the
 * session, and one reminder after 24 hours. `pending` asks while the item
 * keeps verifying, as a pending-human check does.
 */
export function askWithLink(
  db: Database,
  input: {
    item: WorkItemRecord;
    runId: string | null;
    kind: LinkAskKind;
    head: string;
    title?: string;
    detail: string;
    publicUrl: string | null;
    now: number;
    pending?: boolean;
    /** The item version the ask was decided on; a newer item makes the ask stale. */
    version?: number;
    rounds?: LinkAskRounds;
  },
): { question: StoredQuestion; linkAsk: LinkAsk } {
  if (!linkAskAvailable(input.publicUrl)) throw new Error(LINK_ASK_NEEDS_PUBLIC_URL);
  const { item } = input;
  if (item.sessionKey === null) throw new Error("Question owner is stale");
  const answerers = [delegatedLinearUserId(db, item.id), projectLeadId(db, item.id)].filter(
    (id): id is string => id !== null,
  );
  return immediate(db, () => {
    const opened = openLinkAsk(db, {
      ask: (store, asker, ...rest) =>
        ask(
          store,
          {
            ...asker,
            ...(input.pending ? { pending: true } : {}),
            ...(input.version === undefined ? {} : { version: input.version }),
          },
          ...rest,
        ),
      asker: { itemId: item.id, runId: input.runId, sessionId: item.sessionKey! },
      kind: input.kind,
      head: input.head,
      link: linkAskUrl(input.publicUrl!, item, input.kind),
      ...(input.title === undefined ? {} : { title: input.title }),
      detail: input.detail,
      answerers,
      ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
      now: input.now,
    });
    enqueueJobOnce(db, {
      queue: JOB_KIND.linkAskReminder,
      jobKey: `link-ask-reminder:${opened.question.id}`,
      payload: { questionId: opened.question.id },
      runAt: input.now + LINK_ASK_REMINDER_MS,
      now: input.now,
    });
    return opened;
  });
}

/** Posts the one reminder while the ask is still open. Returns whether it posted. */
export function remindLinkAsk(db: Database, questionId: string, now: number): boolean {
  return immediate(db, () => {
    const question = getQuestion(db, questionId);
    const linkAsk = getLinkAsk(db, questionId);
    if (question?.status !== "open" || linkAsk === null || linkAsk.closedAt !== null) return false;
    const item = getWorkItem(db, question.itemId);
    if (item === null || item.cancelRequested || ENDED.has(item.state)) return false;
    const before = db
      .query<{ id: number }, [string]>("SELECT id FROM outbox WHERE idempotency_key = ?")
      .get(`link-ask-reminder:${questionId}`);
    if (before !== null) return false;
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: question.sessionId,
      idempotencyKey: `link-ask-reminder:${questionId}`,
      payload: {
        id: crypto.randomUUID(),
        sessionId: question.sessionId,
        questionId,
        body: linkAskReminderBody(linkAsk),
        options: [],
      },
      now,
    });
    return true;
  });
}

/**
 * What an `approve` does for one kind, inside the decision's transaction.
 * Returns false to fall back to handing the decision to the agent.
 */
export type LinkAskEffects = Partial<
  Record<LinkAskKind, (linkAsk: LinkAsk, item: WorkItemRecord, now: number) => boolean>
>;

/** One failed check a person bypasses on the item page, with their reason. */
export type LinkAskBypass = { checkId: string; reason: string };

export const BYPASS_REPLY_NOTE =
  "A reply in Linear cannot bypass a Closeout check. I sent it to the agent as guidance. Bypass a check with a reason on the item page in Paws:";

/**
 * A signed-in person decided on the item page. Checks `canAnswer` against the
 * delegator and the project lead, writes the Audit history row, closes the
 * ask, posts what was decided, and hands the item on.
 */
export function decideLinkAsk(
  db: Database,
  input: {
    questionId: string;
    decision: LinkAskDecision;
    note: string | null;
    /** The checks a bypass approval bypasses, each with its reason. */
    bypasses?: readonly LinkAskBypass[];
    answeredBy: string;
    actor: { workspaceId: string; userId: string; name: string };
    /** Screenshots a person drew on to request changes on a visual review. */
    marks?: readonly VisualReviewMark[];
    now: number;
  },
  effects: LinkAskEffects = {},
): "answered" | "forbidden" | "rejected" {
  return immediate(db, () => {
    const { now } = input;
    const linkAsk = getLinkAsk(db, input.questionId);
    const question = getQuestion(db, input.questionId);
    if (linkAsk === null || linkAsk.closedAt !== null || question?.status !== "open")
      return "rejected";
    const item = getWorkItem(db, linkAsk.itemId);
    if (item === null || item.cancelRequested || ENDED.has(item.state)) return "rejected";
    if (!canAnswer({ kind: "link", allowedIds: linkAsk.answerers }, { id: input.answeredBy }))
      return "forbidden";
    if (!LINK_ASK_DECISIONS[linkAsk.kind].includes(input.decision)) return "rejected";
    if (LINK_ASK_NOTE_REQUIRED.has(input.decision) && !input.note) return "rejected";
    const bypassing = linkAsk.kind === "bypass" && input.decision === "approve";
    const bypasses = bypassing ? validBypasses(db, linkAsk, input.bypasses ?? []) : null;
    if (bypassing && bypasses === null) return "rejected";
    // The reasons are the note of a bypass: Audit history, the session note and the handoff carry them.
    const note = bypasses
      ? bypasses.map((entry) => `${entry.checkId}: ${entry.reason}`).join("; ")
      : input.note;
    const answered = answerQuestion(db, question.id, {
      answer: note ? `${input.decision}: ${note}` : input.decision,
      answeredBy: input.answeredBy,
      eventKey: `dashboard:${crypto.randomUUID()}`,
      now,
    });
    if (answered === null) return "rejected";
    recordLinkAskDecision(db, linkAsk.questionId, {
      decision: input.decision,
      note,
      decidedBy: input.answeredBy,
      now,
    });
    if (
      bypasses &&
      !approveCloseoutBypassChecks(db, linkAsk.questionId, {
        checks: bypasses,
        approvedBy: input.answeredBy,
        approvedByName: input.actor.name,
        now,
      })
    )
      throw new Error("Closeout bypass checks changed while deciding");
    auditWorkspaceAccess(db, {
      workspaceId: input.actor.workspaceId,
      userId: input.actor.userId,
      action: `decision.${linkAsk.kind}.${input.decision}`,
      subject: [
        item.linearIdentifier ?? item.id,
        shortCommit(linkAsk.headCommit),
        ...(note ? [note] : []),
      ].join(" · "),
      now,
    });
    removeLinkAskUrl(db, linkAsk.questionId, now);
    postNote(
      db,
      question.sessionId,
      item,
      linkAskDecidedNote(linkAsk, input.decision, input.actor.name, note),
      `link-ask-decided:${linkAsk.questionId}`,
      now,
    );
    if (
      linkAsk.kind === "screenshots" &&
      input.decision !== "answer" &&
      decideVisualReview(db, {
        linkAsk,
        decision: input.decision,
        feedback: input.note ?? "",
        answeredBy: input.answeredBy,
        ...(input.marks ? { marks: input.marks } : {}),
        now,
      })
    )
      return "answered";
    const current = getWorkItem(db, item.id)!;
    if (input.decision === "approve" && effects[linkAsk.kind]?.(linkAsk, current, now))
      return "answered";
    if (input.decision === "stop") {
      stopAfterRounds(db, current, linkAsk, input.actor.name, now);
      return "answered";
    }
    handBack(db, current, question, linkAskHandoff(linkAsk, { ...input, note }), now);
    return "answered";
  });
}

/**
 * The checks a bypass may waive: at least one, each offered by this ask and
 * not decided yet, each once, each with a reason. Null otherwise.
 */
function validBypasses(
  db: Database,
  linkAsk: LinkAsk,
  bypasses: readonly LinkAskBypass[],
): LinkAskBypass[] | null {
  const offered = new Set(
    listCloseoutBypassChecks(db, linkAsk.questionId)
      .filter((check) => check.approvedAt === null)
      .map((check) => check.checkId),
  );
  const chosen = bypasses.map((entry) => ({
    checkId: entry.checkId,
    reason: entry.reason.trim(),
  }));
  const ids = new Set(chosen.map((entry) => entry.checkId));
  if (
    chosen.length === 0 ||
    ids.size !== chosen.length ||
    chosen.some((entry) => !offered.has(entry.checkId) || entry.reason === "")
  )
    return null;
  return chosen;
}

/**
 * A person bypassed checks on the item page: the item verifies the same head
 * again, and the bypass rows (bound to that head and policy digest) waive the
 * checks, as `recoveryOptions` reads them.
 */
export function reverifyBypassed(
  db: Database,
  linkAsk: LinkAsk,
  item: WorkItemRecord,
  now: number,
): boolean {
  const recovery = listCloseoutRecoveries(db, item.id).find(
    (entry) => entry.questionId === linkAsk.questionId,
  );
  if (recovery === undefined || item.state !== "awaiting_input") return false;
  db.run("UPDATE question SET handoff_version=0 WHERE id=?", [linkAsk.questionId]);
  applyWorkItemEvent(db, item.id, "answer_received");
  applyWorkItemEvent(db, item.id, "turn_ended");
  saveCheckpoint(db, item.id, {
    phase: "verifying",
    baseSha: recovery.base,
    wipCommit: recovery.head,
  });
  enqueueJobOnce(db, {
    queue: JOB_KIND.reverify,
    jobKey: `closeout-bypass:${linkAsk.questionId}`,
    payload: { itemId: item.id },
    now,
  });
  return true;
}

/**
 * A reply in Linear while a link ask is open. It is guidance for the agent and
 * never approves, bypasses or answers the ask, whatever it says: the ask
 * closes undecided and the item goes back to the agent with the reply. On a
 * visual review the reply is the change request, as Request changes on the page.
 */
export function guideLinkAsk(
  db: Database,
  input: { questionId: string; eventKey: string; body: string; answeredBy: string; now: number },
): boolean {
  return immediate(db, () => {
    const { now } = input;
    const linkAsk = getLinkAsk(db, input.questionId);
    const question = getQuestion(db, input.questionId);
    if (linkAsk === null || linkAsk.closedAt !== null || question?.status !== "open") return false;
    const item = getWorkItem(db, linkAsk.itemId);
    if (item === null || item.cancelRequested || ENDED.has(item.state)) return false;
    // On a rounds ask the reply is Rethink the approach, with the reply as the note.
    const rethink = linkAsk.kind === "rounds";
    const answered = answerQuestion(db, question.id, {
      answer: `${rethink ? "rethink" : "guidance"}: ${input.body}`,
      answeredBy: input.answeredBy,
      eventKey: input.eventKey,
      now,
    });
    if (answered === null) return false;
    if (rethink)
      recordLinkAskDecision(db, linkAsk.questionId, {
        decision: "rethink",
        note: input.body,
        decidedBy: input.answeredBy,
        now,
      });
    else
      closeLinkAsk(db, linkAsk.questionId, {
        reason: "guidance",
        note: input.body,
        by: input.answeredBy,
        now,
      });
    removeLinkAskUrl(db, linkAsk.questionId, now);
    if (item.sessionKey === question.sessionId)
      applyLinearTurns(db, question.sessionId, [input.eventKey], item.id);
    const changes =
      linkAsk.kind === "screenshots" &&
      decideVisualReview(db, {
        linkAsk,
        decision: "changes",
        feedback: input.body,
        answeredBy: input.answeredBy,
        now,
      });
    postNote(
      db,
      question.sessionId,
      item,
      rethink
        ? REVIEW_ROUNDS_REPLY_NOTE
        : changes
          ? VISUAL_REVIEW_REPLY_NOTE
          : linkAsk.kind === "bypass" && BYPASS_REPLY.test(input.body)
            ? `${BYPASS_REPLY_NOTE} ${linkAsk.link}`
            : LINK_ASK_GUIDANCE_NOTE,
      `link-ask-guidance:${linkAsk.questionId}`,
      now,
    );
    if (changes) return true;
    handBack(
      db,
      getWorkItem(db, item.id)!,
      question,
      linkAskHandoff(linkAsk, { decision: "guidance", note: input.body }),
      now,
    );
    return true;
  });
}

/**
 * Head `head` is the item's candidate now. Every open link ask bound to
 * another commit closes undecided; the next one is asked about `head`.
 * `keep` names asks whose commit has the same patch as `head`, which stay
 * open. Returns how many closed.
 */
export function closeLinkAsksOnHead(
  db: Database,
  itemId: string,
  head: string,
  now: number,
  keep: readonly string[] = [],
): number {
  return immediate(db, () => {
    const moved = openLinkAsks(db, itemId).filter(
      (entry) => entry.headCommit !== head && !keep.includes(entry.questionId),
    );
    const item = getWorkItem(db, itemId);
    for (const linkAsk of moved) {
      closeLinkAsk(db, linkAsk.questionId, { reason: "head_moved", now });
      const question = getQuestion(db, linkAsk.questionId);
      if (question?.status === "open" || question?.status === "queued")
        cancelQuestion(db, linkAsk.questionId, now);
      removeLinkAskUrl(db, linkAsk.questionId, now);
      if (item !== null && question !== null && question.status === "open")
        postNote(
          db,
          question.sessionId,
          item,
          `The decision on ${shortCommit(linkAsk.headCommit)} is closed: the branch moved to ${shortCommit(head)}.`,
          `link-ask-moved:${linkAsk.questionId}`,
          now,
        );
    }
    return moved.length;
  });
}

/** Stop on a rounds ask: the item fails as asked, and the branch keeps the work. */
function stopAfterRounds(
  db: Database,
  item: WorkItemRecord,
  linkAsk: LinkAsk,
  by: string,
  now: number,
): void {
  const resumed =
    item.state === "awaiting_input" ? applyWorkItemEvent(db, item.id, "answer_received") : item;
  const rounds = linkAsk.rounds?.rounds.length ?? 0;
  failWorkItem(
    db,
    resumed,
    "closeout:review_rounds",
    `Stopped after ${rounds} failed review ${rounds === 1 ? "round" : "rounds"}, as ${by} asked in Paws. The work is on branch \`${resumed.branchName || worktreeBranch(resumed)}\`.`,
    now,
  );
}

function handBack(
  db: Database,
  item: WorkItemRecord,
  question: StoredQuestion,
  body: string,
  now: number,
): void {
  const jobId = restart(db, item, {
    reason: "answer",
    body,
    jobKey: `resume:link-ask:${question.id}`,
    now,
  });
  if (jobId !== null)
    db.run("UPDATE question SET handoff_version = ? WHERE id = ?", [
      getWorkItem(db, item.id)!.version,
      question.id,
    ]);
}
