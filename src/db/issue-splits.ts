import { and, asc, count, eq, isNull } from "drizzle-orm";
import { validateSubIssueDrafts, type FiledSubIssue, type SubIssueDraft } from "../core";
import type { Q, Steps } from "./db";
import { jsonText, jsonValue } from "./json-text";

export type IssueSplitStatus = "asked" | "approved" | "auto" | "rejected" | "edited";

export type IssueSplit = {
  id: string;
  itemId: string;
  workspaceId: string | null;
  parentIssueId: string;
  parentIdentifier: string;
  repository: string | null;
  drafts: SubIssueDraft[];
  questionId: string | null;
  status: IssueSplitStatus;
  decidedBy: string | null;
  createdAt: number;
  filedAt: number | null;
  closedAt: number | null;
};

export type IssueSplitPart = FiledSubIssue & { position: number; mergedAt: number | null };

type NewIssueSplit = Omit<IssueSplit, "decidedBy" | "filedAt" | "closedAt" | "drafts"> & {
  drafts: readonly SubIssueDraft[];
};

export function* insertIssueSplitSteps(q: Q, input: NewIssueSplit): Steps<IssueSplit> {
  yield* q.exec(
    q.orm.insert(q.t.issueSplit).values({
      ...input,
      drafts: jsonValue(q, validateSubIssueDrafts(input.drafts)),
    }),
  );
  return (yield* getIssueSplitSteps(q, input.id))!;
}

function selectSplits(q: Q) {
  const table = q.t.issueSplit;
  return q.orm
    .select({
      id: table.id,
      itemId: table.itemId,
      workspaceId: table.workspaceId,
      parentIssueId: table.parentIssueId,
      parentIdentifier: table.parentIdentifier,
      repository: table.repository,
      drafts: jsonText(q, table.drafts),
      questionId: table.questionId,
      status: table.status,
      decidedBy: table.decidedBy,
      createdAt: table.createdAt,
      filedAt: table.filedAt,
      closedAt: table.closedAt,
    })
    .from(table);
}

type SplitRow = Omit<IssueSplit, "drafts" | "status"> & { drafts: string; status: string };

function splitOf(row: SplitRow | undefined): IssueSplit | null {
  return row === undefined
    ? null
    : {
        ...row,
        status: row.status as IssueSplitStatus,
        drafts: validateSubIssueDrafts(JSON.parse(row.drafts)),
      };
}

export function* getIssueSplitSteps(q: Q, id: string): Steps<IssueSplit | null> {
  return splitOf(yield* q.one(selectSplits(q).where(eq(q.t.issueSplit.id, id))));
}

export function* issueSplitForQuestionSteps(q: Q, questionId: string): Steps<IssueSplit | null> {
  return splitOf(yield* q.one(selectSplits(q).where(eq(q.t.issueSplit.questionId, questionId))));
}

export function* unfiledAutoSplitSteps(q: Q, itemId: string): Steps<IssueSplit | null> {
  const table = q.t.issueSplit;
  return splitOf(
    yield* q.one(
      selectSplits(q).where(
        and(eq(table.itemId, itemId), eq(table.status, "auto"), isNull(table.filedAt)),
      ),
    ),
  );
}

export function* decideIssueSplitSteps(
  q: Q,
  id: string,
  status: IssueSplitStatus,
  decidedBy: string | null,
): Steps<void> {
  const table = q.t.issueSplit;
  yield* q.exec(q.orm.update(table).set({ status, decidedBy }).where(eq(table.id, id)));
}

export function* approvedSplitCountSteps(q: Q, workspaceId: string | null): Steps<number> {
  if (workspaceId === null) return 0;
  const table = q.t.issueSplit;
  const row = yield* q.one(
    q.orm
      .select({ n: count() })
      .from(table)
      .where(and(eq(table.workspaceId, workspaceId), eq(table.status, "approved"))),
  );
  return Number(row?.n ?? 0);
}

export function* recordSplitFiledSteps(
  q: Q,
  id: string,
  filed: readonly FiledSubIssue[],
  now: number,
): Steps<void> {
  for (const [position, issue] of filed.entries())
    yield* q.exec(
      q.orm
        .insert(q.t.issueSplitPart)
        .values({
          issueId: issue.id,
          splitId: id,
          identifier: issue.identifier,
          url: issue.url,
          position,
        })
        .onConflictDoNothing(),
    );
  const table = q.t.issueSplit;
  yield* q.exec(
    q.orm
      .update(table)
      .set({ filedAt: now })
      .where(and(eq(table.id, id), isNull(table.filedAt))),
  );
}

export function* splitPartOfIssueSteps(q: Q, issueId: string): Steps<boolean> {
  const table = q.t.issueSplitPart;
  return (
    (yield* q.one(
      q.orm.select({ id: table.issueId }).from(table).where(eq(table.issueId, issueId)),
    )) !== undefined
  );
}

export function* splitPartsSteps(q: Q, splitId: string): Steps<IssueSplitPart[]> {
  const table = q.t.issueSplitPart;
  const rows = yield* q.all(
    q.orm.select().from(table).where(eq(table.splitId, splitId)).orderBy(asc(table.position)),
  );
  return rows.map((row) => ({
    id: row.issueId,
    identifier: row.identifier,
    url: row.url,
    position: row.position,
    mergedAt: row.mergedAt,
  }));
}

export function* closeMergedSplitSteps(
  q: Q,
  issueId: string,
  now: number,
): Steps<{ split: IssueSplit; parts: IssueSplitPart[] } | null> {
  const part = q.t.issueSplitPart;
  const found = yield* q.one(
    q.orm.select({ splitId: part.splitId }).from(part).where(eq(part.issueId, issueId)),
  );
  if (found === undefined) return null;
  yield* q.exec(
    q.orm
      .update(part)
      .set({ mergedAt: now })
      .where(and(eq(part.issueId, issueId), isNull(part.mergedAt))),
  );
  const split = yield* getIssueSplitSteps(q, found.splitId);
  const parts = yield* splitPartsSteps(q, found.splitId);
  if (split === null || split.closedAt !== null || parts.some((entry) => entry.mergedAt === null))
    return null;
  const table = q.t.issueSplit;
  yield* q.exec(q.orm.update(table).set({ closedAt: now }).where(eq(table.id, split.id)));
  return { split, parts };
}
