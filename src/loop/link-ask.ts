import { askSteps, restart } from "./operations";
import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  outboxKeyExistsSteps,
  setQuestionHandoffVersionSteps,
  applyLinearTurnsSteps,
  applyWorkItemEventSteps,
  approveCloseoutBypassChecksSteps,
  auditWorkspaceAccessSteps,
  closeLinkAskSteps,
  commandInstance,
  delegatedLinearUserIdSteps,
  emitJobReady,
  enqueueJobOnceSteps,
  enqueueOutboxOnceSteps,
  failWorkItemSteps,
  getLinkAskSteps,
  getWorkItemSteps,
  listCloseoutBypassChecksSteps,
  listCloseoutRecoveriesSteps,
  LINK_ASK_DECISIONS,
  LINK_ASK_NOTE_REQUIRED,
  openLinkAsksSteps,
  schedulingProjectLeadSteps,
  settled,
  recordLinkAskDecisionSteps,
  saveCheckpointSteps,
  sqliteDb,
  type LinkAsk,
  type LinkAskDecision,
  type LinkAskKind,
  type VisualReviewMark,
  type LinkAskRounds,
  type Q,
  type Steps,
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
  openLinkAskSteps,
  removeLinkAskUrl,
  shortCommit,
  type StoredQuestion,
} from "../questions";
import { BYPASS_REPLY } from "./closeout-recovery";
import { worktreeBranch } from "./sources";
import {
  approveRiskSteps,
  postRiskActivitySteps,
  riskDecidedNote,
  riskReplyHandoff,
  RISK_REPLY_NOTE,
  stopForRiskSteps,
} from "./risk-approval";
import { decideVisualReview, postNote, VISUAL_REVIEW_REPLY_NOTE } from "./visual-review";
import { dashboardIssuePath } from "../dashboard-links";

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

/** `https://paws.example/dashboard/issues/PAS-633#closeout` */
export function linkAskUrl(publicUrl: string, item: WorkItemRecord, kind: LinkAskKind): string {
  const issue = dashboardIssuePath(item.linearIdentifier ?? item.id);
  return `${publicUrl.replace(/\/+$/, "")}${issue}#${LINK_ASK_ANCHORS[kind]}`;
}

/**
 * Asks the delegator or the project lead for a decision on the item page:
 * one elicitation with a Markdown body and no options, the link on the
 * session, and one reminder after 24 hours. `pending` asks while the item
 * keeps verifying, as a pending-human check does.
 */
type AskWithLink = {
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
  findings?: string;
};

export function* askWithLinkSteps(
  q: Q,
  input: AskWithLink,
): Steps<{ question: StoredQuestion; linkAsk: LinkAsk }> {
  if (!linkAskAvailable(input.publicUrl)) throw new Error(LINK_ASK_NEEDS_PUBLIC_URL);
  const { item } = input;
  if (item.sessionKey === null) throw new Error("Question owner is stale");
  const answerers = [
    yield* delegatedLinearUserIdSteps(q, item.id),
    yield* schedulingProjectLeadSteps(q, item.id),
  ].filter((id): id is string => id !== null);
  const opened = yield* openLinkAskSteps(q, {
    ask: (reads, asker, ...rest) =>
      askSteps(
        reads,
        {
          ...asker,
          ...(input.pending ? { pending: true } : {}),
          ...(input.version === undefined ? {} : { version: input.version }),
        },
        ...rest,
      ),
    asker: { itemId: item.id, runId: input.runId, sessionId: item.sessionKey },
    kind: input.kind,
    head: input.head,
    link: linkAskUrl(input.publicUrl!, item, input.kind),
    ...(input.title === undefined ? {} : { title: input.title }),
    detail: input.detail,
    answerers,
    ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
    ...(input.findings ? { findings: input.findings } : {}),
    now: input.now,
  });
  yield* enqueueJobOnceSteps(q, {
    queue: JOB_KIND.linkAskReminder,
    jobKey: `link-ask-reminder:${opened.question.id}`,
    payload: { questionId: opened.question.id },
    runAt: input.now + LINK_ASK_REMINDER_MS,
    now: input.now,
  });
  return opened;
}

export function askWithLink(
  db: Database,
  input: AskWithLink,
): { question: StoredQuestion; linkAsk: LinkAsk } {
  const opened = settled(sqliteDb(db).transaction((q) => askWithLinkSteps(q, input)));
  emitJobReady(db);
  return opened;
}

/** Posts the one reminder while the ask is still open. Returns whether it posted. */
export async function remindLinkAsk(
  db: Database,
  questionId: string,
  now: number,
): Promise<boolean> {
  return await sqliteDb(db).transaction(function* (q) {
    const question = getQuestion(db, questionId);
    const linkAsk = yield* getLinkAskSteps(q, questionId);
    if (question?.status !== "open" || linkAsk === null || linkAsk.closedAt !== null) return false;
    const item = yield* getWorkItemSteps(q, question.itemId);
    if (item === null || item.cancelRequested || ENDED.has(item.state)) return false;
    if (yield* outboxKeyExistsSteps(q, `link-ask-reminder:${questionId}`)) return false;
    yield* enqueueOutboxOnceSteps(q, {
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
 * What an `approve` did: `applied` false falls back to handing the decision to
 * the agent; `jobReady` wakes the job queue once the decision commits.
 */
export type LinkAskEffectResult = { applied: boolean; jobReady: boolean };

/** What an `approve` does for one kind, inside the decision's transaction. */
export type LinkAskEffects = Partial<
  Record<
    LinkAskKind,
    (q: Q, linkAsk: LinkAsk, item: WorkItemRecord, now: number) => Steps<LinkAskEffectResult>
  >
>;

/** One failed check a person bypasses on the item page, with their reason. */
export type LinkAskBypass = { checkId: string; reason: string };

export const BYPASS_REPLY_NOTE =
  "A reply in Linear cannot bypass a Closeout check. I sent it to the agent as guidance. Bypass a check with a reason on the item page in Paws:";

export const RULE_REPLY_NOTE =
  "A reply in Linear cannot approve a rule break. I sent the finding back to the agent with your reply. Approve a break with a reason on the item page in Paws:";

/**
 * A signed-in person decided on the item page. Checks `canAnswer` against the
 * delegator and the project lead, writes the Audit history row, closes the
 * ask, posts what was decided, and hands the item on. `stop` is Stop on the
 * Risk card: the item stops and its pull request stays open.
 */
export async function decideLinkAsk(
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
): Promise<"answered" | "forbidden" | "rejected"> {
  const store = sqliteDb(db);
  let jobReady = false;
  const notifications = { ready: false };
  const outcome = await store.transaction(function* (q): Steps<
    "answered" | "forbidden" | "rejected"
  > {
    const { now } = input;
    const linkAsk = yield* getLinkAskSteps(q, input.questionId);
    const question = getQuestion(db, input.questionId);
    if (linkAsk === null || linkAsk.closedAt !== null || question?.status !== "open")
      return "rejected";
    const item = yield* getWorkItemSteps(q, linkAsk.itemId);
    if (item === null || item.cancelRequested || ENDED.has(item.state)) return "rejected";
    if (!canAnswer({ kind: "link", allowedIds: linkAsk.answerers }, { id: input.answeredBy }))
      return "forbidden";
    if (!LINK_ASK_DECISIONS[linkAsk.kind].includes(input.decision)) return "rejected";
    if (LINK_ASK_NOTE_REQUIRED.has(input.decision) && !input.note) return "rejected";
    if (input.decision === "stop" && linkAsk.kind === "risk")
      return yield* stopRiskAskSteps(q, db, linkAsk, item, input, notifications);
    const bypassing = linkAsk.kind === "bypass" && input.decision === "approve";
    // Approving a rule break needs a reason; it covers every rule the ask holds.
    const approvingRule = linkAsk.kind === "rule" && input.decision === "approve";
    if (approvingRule && !input.note?.trim()) return "rejected";
    const bypasses = bypassing
      ? yield* validBypassesSteps(q, linkAsk, input.bypasses ?? [])
      : approvingRule
        ? (yield* heldRulesSteps(q, linkAsk)).map((checkId) => ({
            checkId,
            reason: input.note!.trim(),
          }))
        : null;
    if ((bypassing || approvingRule) && !bypasses?.length) return "rejected";
    // The reasons are the note of a bypass: Audit history, the session note and the handoff carry them.
    const note =
      bypasses && bypassing
        ? bypasses.map((entry) => `${entry.checkId}: ${entry.reason}`).join("; ")
        : approvingRule
          ? input.note!.trim()
          : input.note;
    const answered = answerQuestion(db, question.id, {
      answer: note ? `${input.decision}: ${note}` : input.decision,
      answeredBy: input.answeredBy,
      eventKey: `dashboard:${crypto.randomUUID()}`,
      now,
    });
    if (answered === null) return "rejected";
    yield* recordLinkAskDecisionSteps(q, linkAsk.questionId, {
      decision: input.decision,
      note,
      decidedBy: input.answeredBy,
      now,
    });
    if (
      bypasses &&
      !(yield* approveCloseoutBypassChecksSteps(q, linkAsk.questionId, {
        checks: bypasses,
        approvedBy: input.answeredBy,
        approvedByName: input.actor.name,
        now,
      }))
    )
      throw new Error("Closeout bypass checks changed while deciding");
    yield* auditWorkspaceAccessSteps(q, {
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
    // A risk ask comes after the pull request response, so it posts through the risk gate's keys.
    if (linkAsk.kind === "risk" && (input.decision === "approve" || input.decision === "changes"))
      yield* postRiskActivitySteps(q, {
        sessionId: question.sessionId,
        item,
        kind: input.decision === "approve" ? "response" : "thought",
        body: riskDecidedNote(linkAsk, input.decision, input.actor.name, note),
        key: `decided:${linkAsk.questionId}`,
        now,
      });
    else
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
      (input.decision === "approve" || input.decision === "changes") &&
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
    const current = (yield* getWorkItemSteps(q, item.id))!;
    // The approval binds to the ask's head; it never goes to the agent.
    if (input.decision === "approve" && linkAsk.kind === "risk") {
      jobReady = (yield* approveRiskSteps(q, linkAsk, current, now)).jobReady;
      return "answered";
    }
    const effect = input.decision === "approve" ? effects[linkAsk.kind] : undefined;
    if (effect) {
      const result = yield* effect(q, linkAsk, current, now);
      jobReady = result.jobReady;
      if (result.applied) return "answered";
    }
    if (input.decision === "stop") {
      yield* stopAfterRoundsSteps(q, current, linkAsk, input.actor.name, now);
      return "answered";
    }
    yield* handBackSteps(
      q,
      db,
      current,
      question,
      linkAskHandoff(linkAsk, { ...input, note, ...(yield* ruleFindingsSteps(q, linkAsk)) }),
      now,
      linkAsk.kind === "risk" ? "review" : "answer",
    );
    return "answered";
  });
  if (jobReady || notifications.ready) emitJobReady(store);
  return outcome;
}

/** The rules a `rule` ask holds that nobody approved yet. */
function* heldRulesSteps(q: Q, linkAsk: LinkAsk): Steps<string[]> {
  return (yield* listCloseoutBypassChecksSteps(q, linkAsk.questionId))
    .filter((check) => check.approvedAt === null)
    .map((check) => check.checkId);
}

/** On a `rule` ask, the findings a send back or a reply in Linear hands the agent. */
function* ruleFindingsSteps(q: Q, linkAsk: LinkAsk): Steps<{ findings?: string }> {
  if (linkAsk.kind !== "rule") return {};
  const findings = (yield* listCloseoutBypassChecksSteps(q, linkAsk.questionId))
    .map((check) => check.message.trim())
    .filter(Boolean)
    .join("\n\n");
  return findings ? { findings } : {};
}

/**
 * Stop on the Risk card, inside the decision's transaction: answers and closes the ask, writes
 * the Audit history row and stops the item with its pull request left open.
 */
function* stopRiskAskSteps(
  q: Q,
  db: Database,
  linkAsk: LinkAsk,
  item: WorkItemRecord,
  input: {
    questionId: string;
    note: string | null;
    answeredBy: string;
    actor: { workspaceId: string; userId: string; name: string };
    now: number;
  },
  notifications: { ready: boolean },
): Steps<"answered" | "rejected"> {
  const { now } = input;
  const answered = answerQuestion(db, linkAsk.questionId, {
    answer: input.note ? `stop: ${input.note}` : "stop",
    answeredBy: input.answeredBy,
    eventKey: `dashboard:${crypto.randomUUID()}`,
    now,
  });
  if (answered === null) return "rejected";
  yield* closeLinkAskSteps(q, linkAsk.questionId, {
    reason: "cancelled",
    ...(input.note ? { note: input.note } : {}),
    by: input.answeredBy,
    now,
  });
  yield* auditWorkspaceAccessSteps(q, {
    workspaceId: input.actor.workspaceId,
    userId: input.actor.userId,
    action: "decision.risk.stop",
    subject: [
      item.linearIdentifier ?? item.id,
      shortCommit(linkAsk.headCommit),
      ...(input.note ? [input.note] : []),
    ].join(" · "),
    now,
  });
  removeLinkAskUrl(db, linkAsk.questionId, now);
  if (
    !(yield* stopForRiskSteps(
      q,
      linkAsk,
      (yield* getWorkItemSteps(q, item.id))!,
      input.actor.name,
      now,
      commandInstance(db),
      notifications,
    ))
  )
    throw new Error("The item changed before Stop committed");
  return "answered";
}

/**
 * The checks a bypass may waive: at least one, each offered by this ask and
 * not decided yet, each once, each with a reason. Null otherwise.
 */
function* validBypassesSteps(
  q: Q,
  linkAsk: LinkAsk,
  bypasses: readonly LinkAskBypass[],
): Steps<LinkAskBypass[] | null> {
  const offered = new Set(
    (yield* listCloseoutBypassChecksSteps(q, linkAsk.questionId))
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
export function* reverifyBypassedSteps(
  q: Q,
  linkAsk: LinkAsk,
  item: WorkItemRecord,
  now: number,
): Steps<LinkAskEffectResult> {
  const recovery = (yield* listCloseoutRecoveriesSteps(q, item.id)).find(
    (entry) => entry.questionId === linkAsk.questionId,
  );
  if (recovery === undefined || item.state !== "awaiting_input")
    return { applied: false, jobReady: false };
  yield* setQuestionHandoffVersionSteps(q, linkAsk.questionId, 0);
  yield* applyWorkItemEventSteps(q, item.id, "reverify_requested", { now });
  yield* saveCheckpointSteps(q, item.id, {
    phase: "verifying",
    baseSha: recovery.base,
    wipCommit: recovery.head,
  });
  const { inserted } = yield* enqueueJobOnceSteps(q, {
    queue: JOB_KIND.reverify,
    jobKey: `closeout-bypass:${linkAsk.questionId}`,
    payload: { itemId: item.id },
    now,
  });
  return { applied: true, jobReady: inserted };
}

/**
 * A reply in Linear while a link ask is open. It is guidance for the agent and
 * never approves, bypasses or answers the ask, whatever it says: the ask
 * closes undecided and the item goes back to the agent with the reply. On a
 * visual review or a risk approval the reply is the change request, as
 * Request changes on the page.
 */
export async function guideLinkAsk(
  db: Database,
  input: { questionId: string; eventKey: string; body: string; answeredBy: string; now: number },
): Promise<boolean> {
  return await sqliteDb(db).transaction(function* (q) {
    const { now } = input;
    const linkAsk = yield* getLinkAskSteps(q, input.questionId);
    const question = getQuestion(db, input.questionId);
    if (linkAsk === null || linkAsk.closedAt !== null || question?.status !== "open") return false;
    const item = yield* getWorkItemSteps(q, linkAsk.itemId);
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
      yield* recordLinkAskDecisionSteps(q, linkAsk.questionId, {
        decision: "rethink",
        note: input.body,
        decidedBy: input.answeredBy,
        now,
      });
    else
      yield* closeLinkAskSteps(q, linkAsk.questionId, {
        reason: "guidance",
        note: input.body,
        by: input.answeredBy,
        now,
      });
    removeLinkAskUrl(db, linkAsk.questionId, now);
    if (item.sessionKey === question.sessionId)
      yield* applyLinearTurnsSteps(q, question.sessionId, [input.eventKey], item.id);
    if (linkAsk.kind === "risk") {
      yield* postRiskActivitySteps(q, {
        sessionId: question.sessionId,
        item,
        kind: "thought",
        body: RISK_REPLY_NOTE,
        key: `reply:${linkAsk.questionId}`,
        now,
      });
      yield* handBackSteps(
        q,
        db,
        (yield* getWorkItemSteps(q, item.id))!,
        question,
        riskReplyHandoff(linkAsk, input.body),
        now,
        "review",
      );
      return true;
    }
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
            : linkAsk.kind === "rule"
              ? `${RULE_REPLY_NOTE} ${linkAsk.link}`
              : LINK_ASK_GUIDANCE_NOTE,
      `link-ask-guidance:${linkAsk.questionId}`,
      now,
    );
    if (changes) return true;
    yield* handBackSteps(
      q,
      db,
      (yield* getWorkItemSteps(q, item.id))!,
      question,
      linkAskHandoff(linkAsk, {
        decision: "guidance",
        note: input.body,
        ...(yield* ruleFindingsSteps(q, linkAsk)),
      }),
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
export async function closeLinkAsksOnHead(
  db: Database,
  itemId: string,
  head: string,
  now: number,
  keep: readonly string[] = [],
): Promise<number> {
  return await sqliteDb(db).transaction(function* (q) {
    const moved = (yield* openLinkAsksSteps(q, itemId)).filter(
      (entry) => entry.headCommit !== head && !keep.includes(entry.questionId),
    );
    const item = yield* getWorkItemSteps(q, itemId);
    for (const linkAsk of moved) {
      yield* closeLinkAskSteps(q, linkAsk.questionId, { reason: "head_moved", now });
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
function* stopAfterRoundsSteps(
  q: Q,
  item: WorkItemRecord,
  linkAsk: LinkAsk,
  by: string,
  now: number,
): Steps<void> {
  const resumed =
    item.state === "awaiting_input"
      ? yield* applyWorkItemEventSteps(q, item.id, "answer_received")
      : item;
  const rounds = linkAsk.rounds?.rounds.length ?? 0;
  yield* failWorkItemSteps(
    q,
    resumed,
    "closeout:review_rounds",
    `Stopped after ${rounds} failed review ${rounds === 1 ? "round" : "rounds"}, as ${by} asked in Paws. The work is on branch \`${resumed.branchName || worktreeBranch(resumed)}\`.`,
    now,
  );
}

function* handBackSteps(
  q: Q,
  db: Database,
  item: WorkItemRecord,
  question: StoredQuestion,
  body: string,
  now: number,
  /** A risk change request restarts the item as a changes-requested review does. */
  reason: "answer" | "review" = "answer",
): Steps<void> {
  const jobId = restart(db, item, {
    reason,
    body,
    jobKey: `resume:link-ask:${question.id}`,
    now,
  });
  if (jobId !== null)
    yield* setQuestionHandoffVersionSteps(
      q,
      question.id,
      (yield* getWorkItemSteps(q, item.id))!.version,
    );
}
