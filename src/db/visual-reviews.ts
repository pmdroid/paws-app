import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { settled, sqliteDb, type Db, type Q, type Steps } from "./db";
import { jsonText } from "./json-text";
import {
  getLinearConversationSource,
  getLinearConversationSourceSteps,
} from "./linear-session-url";

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

export async function linearConversationUrlAsync(
  store: Db,
  sessionId: string | null,
  identifier: string,
): Promise<string> {
  const source =
    sessionId === null
      ? null
      : await store.run((q) => getLinearConversationSourceSteps(q, sessionId));
  if (source !== null) {
    try {
      const url = new URL(source);
      if (url.origin === "https://linear.app" && !url.username && !url.password) return url.href;
    } catch (caughtError1) {
      journalCaught(caughtError1, "visual-reviews.linearConversationUrlAsync", null);
    }
  }
  return `https://linear.app/issue/${encodeURIComponent(identifier)}`;
}

export async function linearConversationUrl(
  db: Database,
  sessionId: string | null,
  identifier: string,
): Promise<string> {
  const source =
    sessionId === null ? null : await getLinearConversationSource(sqliteDb(db), sessionId);
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
