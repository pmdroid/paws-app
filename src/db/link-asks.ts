import { and, asc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { type Q, type Db } from "./db";
import { jsonText, jsonValue } from "./json-text";
import type { linkAsk as linkAskTable } from "./schema-pg";

/** What a link ask wants a signed-in person to decide on the item page. */
export type LinkAskKind = "bypass" | "screenshots" | "risk" | "question" | "rounds" | "rule";

export const LINK_ASK_KINDS: readonly LinkAskKind[] = [
  "bypass",
  "screenshots",
  "risk",
  "question",
  "rounds",
  "rule",
];

/**
 * `approve` bypasses, accepts or approves (on `rule`, the break of a rule set to
 * `onFail: approve`, with a reason); `changes` sends the item back with a note;
 * `answer` answers a question kind. `rethink`, `continue` and `stop` answer the
 * `rounds` kind once review attempts ran out; `stop` also stops a `risk` ask with its pull
 * request left open. A Linear reply is none of the first three; on a `rounds` ask it is
 * `rethink` with the reply as the note.
 */
export type LinkAskDecision = "approve" | "changes" | "answer" | "rethink" | "continue" | "stop";

/** The decisions each kind takes on the item page. */
export const LINK_ASK_DECISIONS: Record<LinkAskKind, readonly LinkAskDecision[]> = {
  bypass: ["approve", "changes"],
  screenshots: ["approve", "changes"],
  risk: ["approve", "changes", "stop"],
  question: ["answer"],
  rounds: ["rethink", "continue", "stop"],
  rule: ["approve", "changes"],
};

/** Decisions that need a note: what to change, or the answer. */
export const LINK_ASK_NOTE_REQUIRED: ReadonlySet<LinkAskDecision> = new Set(["changes", "answer"]);

/** One failed review round: the commit reviewed and how many findings it got. */
export type ReviewRound = { head: string; findings: number };

/** A finding the last round still reported, with the class of bug its explanation starts with. */
export type OpenReviewFinding = { severity: string; location: string; bugClass: string };

/** What a `rounds` ask shows: each round, the open findings, and the class that recurs most. */
export type LinkAskRounds = {
  rounds: ReviewRound[];
  open: OpenReviewFinding[];
  /** The bug class reported most often across the rounds. Null when no finding named one. */
  bugClass: string | null;
  /** Rounds a Keep going grants: the policy's `maxFailedReviewAttempts`. Null when unknown. */
  limit: number | null;
  /** The findings as the fixer gets them, for the restart. */
  handoff: string;
};

export type LinkAskClosed = "decided" | "guidance" | "head_moved" | "cancelled";

/** A question answered on the item page, bound to one head commit. Keyed by its question. */
export type LinkAsk = {
  questionId: string;
  itemId: string;
  kind: LinkAskKind;
  headCommit: string;
  link: string;
  title: string;
  detail: string;
  /** Linear user ids that may decide: the delegator and the project lead. */
  answerers: string[];
  createdAt: number;
  decision: LinkAskDecision | null;
  note: string | null;
  decidedBy: string | null;
  decidedAt: number | null;
  closedReason: LinkAskClosed | null;
  closedAt: number | null;
  /** Set on the `rounds` kind only. */
  rounds: LinkAskRounds | null;
};

type LinkAskInput = Omit<
  LinkAsk,
  "decision" | "note" | "decidedBy" | "decidedAt" | "closedReason" | "closedAt" | "rounds"
> & { rounds?: LinkAskRounds };

export function* insertLinkAskSteps(q: Q, input: LinkAskInput) {
  const { linkAsk } = q.t;
  yield* q.exec(
    q.orm.insert(linkAsk).values({
      questionId: input.questionId,
      itemId: input.itemId,
      kind: input.kind,
      headCommit: input.headCommit,
      link: input.link,
      title: input.title,
      detail: input.detail,
      answerers: jsonValue(q, input.answerers),
      createdAt: input.createdAt,
      rounds: input.rounds === undefined ? null : jsonValue(q, input.rounds),
    }),
  );
  return (yield* getLinkAskSteps(q, input.questionId))!;
}

export async function insertLinkAsk(store: Db, input: LinkAskInput): Promise<LinkAsk> {
  return store.run((q) => insertLinkAskSteps(q, input));
}

function selectLinkAsks(q: Q) {
  const { linkAsk } = q.t;
  return q.orm
    .select({
      ...getTableColumns(linkAsk),
      answerers: jsonText(q, linkAsk.answerers),
      rounds: sql<string | null>`${jsonText(q, linkAsk.rounds)}`,
    })
    .from(linkAsk);
}

export function* getLinkAskSteps(q: Q, questionId: string) {
  const row = yield* q.one(selectLinkAsks(q).where(eq(q.t.linkAsk.questionId, questionId)));
  return row === undefined ? null : mapLinkAsk(row);
}

export async function getLinkAsk(store: Db, questionId: string): Promise<LinkAsk | null> {
  return store.run((q) => getLinkAskSteps(q, questionId));
}

/** Link asks of the item that nobody decided and nothing closed, oldest first. */
export function* openLinkAsksSteps(q: Q, itemId: string) {
  const { linkAsk } = q.t;
  const rows = yield* q.all(
    selectLinkAsks(q)
      .where(and(eq(linkAsk.itemId, itemId), isNull(linkAsk.closedAt)))
      .orderBy(asc(linkAsk.createdAt), asc(linkAsk.questionId)),
  );
  return rows.map(mapLinkAsk);
}

export async function openLinkAsks(store: Db, itemId: string): Promise<LinkAsk[]> {
  return store.run((q) => openLinkAsksSteps(q, itemId));
}

/** Every link ask of the item, oldest first. */
export function* listLinkAsksSteps(q: Q, itemId: string) {
  const { linkAsk } = q.t;
  const rows = yield* q.all(
    selectLinkAsks(q)
      .where(eq(linkAsk.itemId, itemId))
      .orderBy(asc(linkAsk.createdAt), asc(linkAsk.questionId)),
  );
  return rows.map(mapLinkAsk);
}

export async function listLinkAsks(store: Db, itemId: string): Promise<LinkAsk[]> {
  return store.run((q) => listLinkAsksSteps(q, itemId));
}

type LinkAskDecisionInput = {
  decision: LinkAskDecision;
  note: string | null;
  decidedBy: string;
  now: number;
};

/** Records who decided what. Returns false when the ask was already closed. */
export function* recordLinkAskDecisionSteps(q: Q, questionId: string, input: LinkAskDecisionInput) {
  const { linkAsk } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(linkAsk)
      .set({
        decision: input.decision,
        note: input.note,
        decidedBy: input.decidedBy,
        decidedAt: input.now,
        closedReason: "decided",
        closedAt: input.now,
      })
      .where(and(eq(linkAsk.questionId, questionId), isNull(linkAsk.closedAt)))
      .returning({ questionId: linkAsk.questionId }),
  );
  return rows.length > 0;
}

export async function recordLinkAskDecision(
  store: Db,
  questionId: string,
  input: LinkAskDecisionInput,
): Promise<boolean> {
  return store.run((q) => recordLinkAskDecisionSteps(q, questionId, input));
}

type LinkAskCloseInput = {
  reason: Exclude<LinkAskClosed, "decided">;
  note?: string;
  by?: string;
  now: number;
};

/** Closes the ask without a decision. A guidance reply keeps its text as the note. */
export function* closeLinkAskSteps(q: Q, questionId: string, input: LinkAskCloseInput) {
  const { linkAsk } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(linkAsk)
      .set({
        closedReason: input.reason,
        closedAt: input.now,
        note: sql`COALESCE(${input.note ?? null}, ${linkAsk.note})`,
        decidedBy: sql`COALESCE(${input.by ?? null}, ${linkAsk.decidedBy})`,
      })
      .where(and(eq(linkAsk.questionId, questionId), isNull(linkAsk.closedAt)))
      .returning({ questionId: linkAsk.questionId }),
  );
  return rows.length > 0;
}

export async function closeLinkAsk(
  store: Db,
  questionId: string,
  input: LinkAskCloseInput,
): Promise<boolean> {
  return store.run((q) => closeLinkAskSteps(q, questionId, input));
}

type LinkAskRow = Omit<typeof linkAskTable.$inferSelect, "answerers" | "rounds"> & {
  answerers: string;
  rounds: string | null;
};

function mapLinkAsk(row: LinkAskRow): LinkAsk {
  return {
    questionId: row.questionId,
    itemId: row.itemId,
    kind: row.kind as LinkAskKind,
    headCommit: row.headCommit,
    link: row.link,
    title: row.title,
    detail: row.detail,
    answerers: JSON.parse(row.answerers) as string[],
    createdAt: row.createdAt,
    decision: row.decision as LinkAskDecision | null,
    note: row.note,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    closedReason: row.closedReason as LinkAskClosed | null,
    closedAt: row.closedAt,
    rounds: row.rounds === null ? null : (JSON.parse(row.rounds) as LinkAskRounds),
  };
}
