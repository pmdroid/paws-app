import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, isNull, ne, sql, type SQL } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { jsonText, jsonValue } from "./json-text";
import { getLinearConversationSource } from "./linear-session-url";

export type VisualReviewRecord = {
  questionId: string;
  checkId: string;
  evidenceIds: string[];
  createdAt: number;
  outcome: "accepted" | "changes_requested" | "stale" | null;
  answeredBy: string | null;
  answeredAt: number | null;
  feedback: string | null;
  headCommit: string | null;
  /** Files that carried an earlier approval over. `approvedBy` is the approver's name when known. */
  carried: VisualReviewCarriedFile[];
};

export type VisualReviewCarriedFile = {
  evidenceId: string;
  fromEvidenceId: string;
  /** Question id of the review a person accepted. */
  approvalId: string;
  approvedBy: string;
  approvedAt: number;
  match: "identical" | "similar";
};

export function* listVisualReviewsSteps(q: Q, itemId: string): Steps<VisualReviewRecord[]> {
  const { visualReview, workspaceUser } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        questionId: visualReview.questionId,
        checkId: visualReview.checkId,
        evidenceIds: jsonText(q, visualReview.evidenceIds),
        createdAt: visualReview.createdAt,
        outcome: visualReview.outcome,
        answeredBy: sql<string | null>`COALESCE(${workspaceUser.name}, ${visualReview.answeredBy})`,
        answeredAt: visualReview.answeredAt,
        feedback: visualReview.feedback,
        headCommit: visualReview.headCommit,
        carried: jsonText(q, visualReview.carried),
      })
      .from(visualReview)
      .leftJoin(workspaceUser, eq(workspaceUser.linearUserId, visualReview.answeredBy))
      .where(and(eq(visualReview.itemId, itemId), eq(visualReview.kind, "review")))
      // Reviews created in the same millisecond keep question id order, the table's key.
      .orderBy(asc(visualReview.createdAt), asc(visualReview.questionId)),
  );
  const reviews: VisualReviewRecord[] = [];
  for (const row of rows)
    reviews.push({
      ...row,
      outcome: row.outcome as VisualReviewRecord["outcome"],
      evidenceIds: JSON.parse(row.evidenceIds) as string[],
      carried: yield* carriedFilesSteps(q, row.carried),
    });
  return reviews;
}

export function listVisualReviews(db: Database, itemId: string): VisualReviewRecord[] {
  return settled(sqliteDb(db).run((q) => listVisualReviewsSteps(q, itemId)));
}

function* carriedFilesSteps(q: Q, value: string | null) {
  if (!value) return [];
  const { workspaceUser } = q.t;
  const files: VisualReviewCarriedFile[] = [];
  for (const entry of JSON.parse(value) as VisualReviewCarriedFile[]) {
    const user = yield* q.one(
      q.orm
        .select({ name: workspaceUser.name })
        .from(workspaceUser)
        .where(and(eq(workspaceUser.linearUserId, entry.approvedBy), ne(workspaceUser.name, ""))),
    );
    files.push({ ...entry, approvedBy: user?.name ?? entry.approvedBy });
  }
  return files;
}

export function linearConversationUrl(
  db: Database,
  sessionId: string | null,
  identifier: string,
): string {
  const source = sessionId === null ? null : getLinearConversationSource(db, sessionId);
  if (source !== null) {
    try {
      const url = new URL(source);
      if (url.origin === "https://linear.app" && !url.username && !url.password) return url.href;
    } catch (caughtError1) {
      journalCaught(caughtError1, "visual-reviews.linearConversationUrl", null);
    }
  }
  return `https://linear.app/issue/${encodeURIComponent(identifier)}`;
}

export type VisualReviewMark = {
  id: string;
  questionId: string;
  evidenceId: string;
  sizeBytes: number;
  sha256: string;
  createdAt: number;
};

function markColumns(q: Q) {
  const { visualReviewMark } = q.t;
  return {
    id: visualReviewMark.id,
    questionId: visualReviewMark.questionId,
    evidenceId: visualReviewMark.evidenceId,
    sizeBytes: visualReviewMark.sizeBytes,
    sha256: visualReviewMark.sha256,
    createdAt: visualReviewMark.createdAt,
  };
}

export function* saveVisualReviewMarksSteps(q: Q, marks: readonly VisualReviewMark[]) {
  for (const mark of marks) yield* q.exec(q.orm.insert(q.t.visualReviewMark).values(mark));
}

export function saveVisualReviewMarks(db: Database, marks: readonly VisualReviewMark[]): void {
  settled(sqliteDb(db).run((q) => saveVisualReviewMarksSteps(q, marks)));
}

export function* listVisualReviewMarksSteps(q: Q, questionId: string) {
  const { visualReviewMark } = q.t;
  const marks: VisualReviewMark[] = yield* q.all(
    q.orm
      .select(markColumns(q))
      .from(visualReviewMark)
      .where(eq(visualReviewMark.questionId, questionId))
      // Marks of the same millisecond keep id order: ids are ULIDs.
      .orderBy(asc(visualReviewMark.createdAt), asc(visualReviewMark.id)),
  );
  return marks;
}

export function listVisualReviewMarks(db: Database, questionId: string): VisualReviewMark[] {
  return settled(sqliteDb(db).run((q) => listVisualReviewMarksSteps(q, questionId)));
}

export function* getVisualReviewMarkSteps(q: Q, id: string) {
  const { visualReview, visualReviewMark } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ ...markColumns(q), itemId: visualReview.itemId })
      .from(visualReviewMark)
      .innerJoin(visualReview, eq(visualReview.questionId, visualReviewMark.questionId))
      .where(eq(visualReviewMark.id, id)),
  );
  return row ?? null;
}

export function getVisualReviewMark(
  db: Database,
  id: string,
): (VisualReviewMark & { itemId: string }) | null {
  return settled(sqliteDb(db).run((q) => getVisualReviewMarkSteps(q, id)));
}

export function* openVisualReviewFilesSteps(q: Q, questionId: string) {
  const { question, visualReview } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        itemId: visualReview.itemId,
        evidenceIds: jsonText(q, visualReview.evidenceIds),
        carried: jsonText(q, visualReview.carried),
      })
      .from(visualReview)
      .innerJoin(question, eq(question.id, visualReview.questionId))
      .where(
        and(
          eq(visualReview.questionId, questionId),
          eq(visualReview.kind, "review"),
          eq(question.status, "open"),
          isNull(question.cancelledAt),
        ),
      ),
  );
  if (row === undefined) return null;
  // Screens that carried an approval over were not asked about.
  const carried = new Set(
    (JSON.parse(row.carried ?? "[]") as { evidenceId: string }[]).map((entry) => entry.evidenceId),
  );
  return {
    itemId: row.itemId,
    evidenceIds: (JSON.parse(row.evidenceIds) as string[]).filter((id) => !carried.has(id)),
  };
}

export function openVisualReviewFiles(
  db: Database,
  questionId: string,
): { itemId: string; evidenceIds: string[] } | null {
  return settled(sqliteDb(db).run((q) => openVisualReviewFilesSteps(q, questionId)));
}

export type VisualReviewRow = {
  questionId: string;
  itemId: string;
  checkId: string;
  evidenceIds: string;
  createdAt: number;
  kind: string;
  outcome: string | null;
  answeredBy: string | null;
  answeredAt: number | null;
  feedback: string | null;
  headCommit: string | null;
  carried: string | null;
};

function rowColumns(q: Q) {
  const { visualReview } = q.t;
  return {
    questionId: visualReview.questionId,
    itemId: visualReview.itemId,
    checkId: visualReview.checkId,
    evidenceIds: jsonText(q, visualReview.evidenceIds),
    createdAt: visualReview.createdAt,
    kind: visualReview.kind,
    outcome: visualReview.outcome,
    answeredBy: visualReview.answeredBy,
    answeredAt: visualReview.answeredAt,
    feedback: visualReview.feedback,
    headCommit: visualReview.headCommit,
    carried: jsonText(q, visualReview.carried) as SQL<string | null>,
  };
}

function answeredFirst(q: Q): SQL[] {
  const { visualReview } = q.t;
  return [
    sql`${visualReview.answeredAt} ASC NULLS FIRST`,
    q.dialect === "sqlite" ? sql`rowid` : asc(visualReview.questionId),
  ];
}

export type NewVisualReviewRow = {
  questionId: string;
  itemId: string;
  checkId: string;
  evidenceIds: readonly string[];
  createdAt: number;
  kind?: "review" | "continue";
  headCommit?: string;
  carried?: readonly unknown[];
  outcome?: "accepted";
  answeredBy?: string;
  answeredAt?: number;
};

export function* insertVisualReviewRowSteps(q: Q, input: NewVisualReviewRow) {
  yield* q.exec(
    q.orm.insert(q.t.visualReview).values({
      ...input,
      kind: input.kind ?? "review",
      evidenceIds: jsonValue(q, input.evidenceIds),
      carried: input.carried?.length ? jsonValue(q, input.carried) : null,
    }),
  );
}

export function insertVisualReviewRow(db: Database, input: NewVisualReviewRow): void {
  settled(sqliteDb(db).run((q) => insertVisualReviewRowSteps(q, input)));
}

export function* visualReviewRowSteps(q: Q, questionId: string) {
  const { visualReview } = q.t;
  const row: VisualReviewRow | undefined = yield* q.one(
    q.orm.select(rowColumns(q)).from(visualReview).where(eq(visualReview.questionId, questionId)),
  );
  return row ?? null;
}

export function visualReviewRow(db: Database, questionId: string): VisualReviewRow | null {
  return settled(sqliteDb(db).run((q) => visualReviewRowSteps(q, questionId)));
}

export function* humanApprovedVisualReviewRowsSteps(q: Q, itemId: string, checkId: string) {
  const { visualReview } = q.t;
  const rows: VisualReviewRow[] = yield* q.all(
    q.orm
      .select(rowColumns(q))
      .from(visualReview)
      .where(
        and(
          eq(visualReview.itemId, itemId),
          eq(visualReview.checkId, checkId),
          eq(visualReview.kind, "review"),
          inArray(visualReview.outcome, ["accepted", "stale"]),
          sql`${visualReview.answeredBy} IS NOT NULL`,
        ),
      )
      .orderBy(...answeredFirst(q)),
  );
  return rows;
}

export function humanApprovedVisualReviewRows(
  db: Database,
  itemId: string,
  checkId: string,
): VisualReviewRow[] {
  return settled(sqliteDb(db).run((q) => humanApprovedVisualReviewRowsSteps(q, itemId, checkId)));
}

export function* acceptedVisualReviewRowsSteps(q: Q, itemId: string) {
  const { visualReview } = q.t;
  const rows: VisualReviewRow[] = yield* q.all(
    q.orm
      .select(rowColumns(q))
      .from(visualReview)
      .where(
        and(
          eq(visualReview.itemId, itemId),
          eq(visualReview.kind, "review"),
          eq(visualReview.outcome, "accepted"),
        ),
      )
      .orderBy(...answeredFirst(q)),
  );
  return rows;
}

export function acceptedVisualReviewRows(db: Database, itemId: string): VisualReviewRow[] {
  return settled(sqliteDb(db).run((q) => acceptedVisualReviewRowsSteps(q, itemId)));
}

export function* rejectedVisualReviewRowsSteps(q: Q, itemId: string) {
  const { visualReview } = q.t;
  const rows: VisualReviewRow[] = yield* q.all(
    q.orm
      .select(rowColumns(q))
      .from(visualReview)
      .where(
        and(
          eq(visualReview.itemId, itemId),
          inArray(visualReview.outcome, ["changes_requested", "stale"]),
        ),
      ),
  );
  return rows;
}

export function rejectedVisualReviewRows(db: Database, itemId: string): VisualReviewRow[] {
  return settled(sqliteDb(db).run((q) => rejectedVisualReviewRowsSteps(q, itemId)));
}

export type VisualReviewAnswerRow = {
  outcome: string;
  answeredBy: string;
  answeredAt: number;
  feedback: string | null;
  headCommit: string | null;
};

export function* saveVisualReviewAnswerSteps(
  q: Q,
  questionId: string,
  answer: VisualReviewAnswerRow,
) {
  const { visualReview } = q.t;
  yield* q.exec(
    q.orm.update(visualReview).set(answer).where(eq(visualReview.questionId, questionId)),
  );
}

export function saveVisualReviewAnswer(
  db: Database,
  questionId: string,
  answer: VisualReviewAnswerRow,
): void {
  settled(sqliteDb(db).run((q) => saveVisualReviewAnswerSteps(q, questionId, answer)));
}

export function* staleAcceptedVisualReviewSteps(q: Q, questionId: string) {
  const { visualReview } = q.t;
  yield* q.exec(
    q.orm
      .update(visualReview)
      .set({ outcome: "stale" })
      .where(and(eq(visualReview.questionId, questionId), eq(visualReview.outcome, "accepted"))),
  );
}

export function staleAcceptedVisualReview(db: Database, questionId: string): void {
  settled(sqliteDb(db).run((q) => staleAcceptedVisualReviewSteps(q, questionId)));
}

export function* visualReviewRoundCountsSteps(q: Q, itemId: string, checkId: string) {
  const { visualReview } = q.t;
  const counted = (kind: string, outcome: string) =>
    sql<number>`COUNT(*) FILTER (WHERE ${and(eq(visualReview.kind, kind), eq(visualReview.outcome, outcome))})`.mapWith(
      Number,
    );
  const row = yield* q.one(
    q.orm
      .select({
        changes: counted("review", "changes_requested"),
        continued: counted("continue", "continued"),
      })
      .from(visualReview)
      .where(and(eq(visualReview.itemId, itemId), eq(visualReview.checkId, checkId))),
  );
  return { changes: row?.changes ?? 0, continued: row?.continued ?? 0 };
}

export function visualReviewRoundCounts(
  db: Database,
  itemId: string,
  checkId: string,
): { changes: number; continued: number } {
  return settled(sqliteDb(db).run((q) => visualReviewRoundCountsSteps(q, itemId, checkId)));
}

export function* lastVisualReviewFeedbackRowSteps(q: Q, itemId: string, checkId: string) {
  const { visualReview } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ questionId: visualReview.questionId, feedback: visualReview.feedback })
      .from(visualReview)
      .where(
        and(
          eq(visualReview.itemId, itemId),
          eq(visualReview.checkId, checkId),
          eq(visualReview.kind, "review"),
          eq(visualReview.outcome, "changes_requested"),
        ),
      )
      .orderBy(
        sql`${visualReview.answeredAt} DESC NULLS LAST`,
        q.dialect === "sqlite" ? sql`rowid DESC` : desc(visualReview.questionId),
      )
      .limit(1),
  );
  return row ?? null;
}

export function lastVisualReviewFeedbackRow(
  db: Database,
  itemId: string,
  checkId: string,
): { questionId: string; feedback: string | null } | null {
  return settled(sqliteDb(db).run((q) => lastVisualReviewFeedbackRowSteps(q, itemId, checkId)));
}
