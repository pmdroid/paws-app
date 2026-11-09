import type { Database } from "bun:sqlite";
import { and, eq, isNull } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";

export type FindingDecision = "fixed" | "declined";

export type SuggestedFindingRecord = {
  itemId: string;
  findingId: string;
  reviewId: string;
  location: string;
  severity: string;
  explanation: string;
  handedAt: number;
  decision: FindingDecision | null;
  reason: string | null;
  head: string | null;
  decidedAt: number | null;
};

export type SuggestionTurnRecord = {
  itemId: string;
  outcome: "started" | "skipped";
  reason: string | null;
  head: string;
  recordedAt: number;
};

type HandedFinding = Pick<
  SuggestedFindingRecord,
  "findingId" | "reviewId" | "location" | "severity" | "explanation"
>;

export function* recordSuggestedFindingsSteps(
  q: Q,
  itemId: string,
  findings: readonly HandedFinding[],
  now: number,
): Steps<void> {
  const { suggestedFinding } = q.t;
  yield* q.exec(
    q.orm
      .delete(suggestedFinding)
      .where(and(eq(suggestedFinding.itemId, itemId), isNull(suggestedFinding.decision))),
  );
  for (const finding of findings)
    yield* q.exec(
      q.orm
        .insert(suggestedFinding)
        .values({
          itemId,
          findingId: finding.findingId,
          reviewId: finding.reviewId,
          location: finding.location,
          severity: finding.severity,
          explanation: finding.explanation,
          handedAt: now,
        })
        .onConflictDoNothing({ target: [suggestedFinding.itemId, suggestedFinding.findingId] }),
    );
}

export function recordSuggestedFindings(
  db: Database,
  itemId: string,
  findings: readonly HandedFinding[],
  now: number,
): void {
  settled(sqliteDb(db).run((q) => recordSuggestedFindingsSteps(q, itemId, findings, now)));
}

export function* suggestedFindingsSteps(q: Q, itemId: string): Steps<SuggestedFindingRecord[]> {
  const { suggestedFinding } = q.t;
  return (yield* q.all(
    q.orm
      .select()
      .from(suggestedFinding)
      .where(eq(suggestedFinding.itemId, itemId))
      .orderBy(suggestedFinding.handedAt, suggestedFinding.findingId),
  )) as SuggestedFindingRecord[];
}

export function suggestedFindings(db: Database, itemId: string): SuggestedFindingRecord[] {
  return settled(sqliteDb(db).run((q) => suggestedFindingsSteps(q, itemId)));
}

type FindingDecisions = ReadonlyMap<string, { decision: FindingDecision; reason: string }>;

export function* decideSuggestedFindingsSteps(
  q: Q,
  itemId: string,
  decisions: FindingDecisions,
  head: string | null,
  now: number,
): Steps<number> {
  const { suggestedFinding } = q.t;
  let stored = 0;
  for (const [findingId, report] of decisions)
    stored += (yield* q.all(
      q.orm
        .update(suggestedFinding)
        .set({ decision: report.decision, reason: report.reason, head, decidedAt: now })
        .where(
          and(
            eq(suggestedFinding.itemId, itemId),
            eq(suggestedFinding.findingId, findingId),
            isNull(suggestedFinding.decision),
          ),
        )
        .returning({ itemId: suggestedFinding.itemId }),
    )).length;
  return stored;
}

export function decideSuggestedFindings(
  db: Database,
  itemId: string,
  decisions: FindingDecisions,
  head: string | null,
  now: number,
): number {
  return settled(
    sqliteDb(db).run((q) => decideSuggestedFindingsSteps(q, itemId, decisions, head, now)),
  );
}

export function* recordSuggestionTurnSteps(q: Q, record: SuggestionTurnRecord): Steps<boolean> {
  const { suggestionTurn } = q.t;
  const inserted = yield* q.all(
    q.orm
      .insert(suggestionTurn)
      .values(record)
      .onConflictDoNothing({ target: suggestionTurn.itemId })
      .returning({ itemId: suggestionTurn.itemId }),
  );
  return inserted.length > 0;
}

export function recordSuggestionTurn(db: Database, record: SuggestionTurnRecord): boolean {
  return settled(sqliteDb(db).run((q) => recordSuggestionTurnSteps(q, record)));
}

export function* getSuggestionTurnSteps(q: Q, itemId: string): Steps<SuggestionTurnRecord | null> {
  const { suggestionTurn } = q.t;
  const row = yield* q.one(
    q.orm.select().from(suggestionTurn).where(eq(suggestionTurn.itemId, itemId)),
  );
  return (row ?? null) as SuggestionTurnRecord | null;
}

export function getSuggestionTurn(db: Database, itemId: string): SuggestionTurnRecord | null {
  return settled(sqliteDb(db).run((q) => getSuggestionTurnSteps(q, itemId)));
}
