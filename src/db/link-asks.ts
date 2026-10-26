import type { Database } from "bun:sqlite";

/** What a link ask wants a signed-in person to decide on the item page. */
export type LinkAskKind = "bypass" | "screenshots" | "risk" | "question";

export const LINK_ASK_KINDS: readonly LinkAskKind[] = ["bypass", "screenshots", "risk", "question"];

/**
 * `approve` bypasses, accepts or approves; `changes` sends the item back with a note;
 * `answer` answers a question kind. A Linear reply is never one of them.
 */
export type LinkAskDecision = "approve" | "changes" | "answer";

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
};

type LinkAskRow = {
  question_id: string;
  item_id: string;
  kind: LinkAskKind;
  head_commit: string;
  link: string;
  title: string;
  detail: string;
  answerers: string;
  created_at: number;
  decision: LinkAskDecision | null;
  note: string | null;
  decided_by: string | null;
  decided_at: number | null;
  closed_reason: LinkAskClosed | null;
  closed_at: number | null;
};

export function insertLinkAsk(
  db: Database,
  input: Omit<
    LinkAsk,
    "decision" | "note" | "decidedBy" | "decidedAt" | "closedReason" | "closedAt"
  >,
): LinkAsk {
  db.run(
    `INSERT INTO link_ask (question_id, item_id, kind, head_commit, link, title, detail, answerers, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.questionId,
      input.itemId,
      input.kind,
      input.headCommit,
      input.link,
      input.title,
      input.detail,
      JSON.stringify(input.answerers),
      input.createdAt,
    ],
  );
  return getLinkAsk(db, input.questionId)!;
}

export function getLinkAsk(db: Database, questionId: string): LinkAsk | null {
  const row = db
    .query<LinkAskRow, [string]>("SELECT * FROM link_ask WHERE question_id = ?")
    .get(questionId);
  return row === null ? null : mapLinkAsk(row);
}

/** Link asks of the item that nobody decided and nothing closed, oldest first. */
export function openLinkAsks(db: Database, itemId: string): LinkAsk[] {
  return db
    .query<LinkAskRow, [string]>(
      "SELECT * FROM link_ask WHERE item_id = ? AND closed_at IS NULL ORDER BY created_at, rowid",
    )
    .all(itemId)
    .map(mapLinkAsk);
}

/** Every link ask of the item, oldest first. */
export function listLinkAsks(db: Database, itemId: string): LinkAsk[] {
  return db
    .query<LinkAskRow, [string]>(
      "SELECT * FROM link_ask WHERE item_id = ? ORDER BY created_at, rowid",
    )
    .all(itemId)
    .map(mapLinkAsk);
}

/** Records who decided what. Returns false when the ask was already closed. */
export function recordLinkAskDecision(
  db: Database,
  questionId: string,
  input: { decision: LinkAskDecision; note: string | null; decidedBy: string; now: number },
): boolean {
  return (
    db.run(
      `UPDATE link_ask SET decision = ?, note = ?, decided_by = ?, decided_at = ?,
         closed_reason = 'decided', closed_at = ?
       WHERE question_id = ? AND closed_at IS NULL`,
      [input.decision, input.note, input.decidedBy, input.now, input.now, questionId],
    ).changes > 0
  );
}

/** Closes the ask without a decision. A guidance reply keeps its text as the note. */
export function closeLinkAsk(
  db: Database,
  questionId: string,
  input: { reason: Exclude<LinkAskClosed, "decided">; note?: string; by?: string; now: number },
): boolean {
  return (
    db.run(
      `UPDATE link_ask SET closed_reason = ?, closed_at = ?, note = COALESCE(?, note),
         decided_by = COALESCE(?, decided_by)
       WHERE question_id = ? AND closed_at IS NULL`,
      [input.reason, input.now, input.note ?? null, input.by ?? null, questionId],
    ).changes > 0
  );
}

function mapLinkAsk(row: LinkAskRow): LinkAsk {
  return {
    questionId: row.question_id,
    itemId: row.item_id,
    kind: row.kind,
    headCommit: row.head_commit,
    link: row.link,
    title: row.title,
    detail: row.detail,
    answerers: JSON.parse(row.answerers) as string[],
    createdAt: row.created_at,
    decision: row.decision,
    note: row.note,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    closedReason: row.closed_reason,
    closedAt: row.closed_at,
  };
}
