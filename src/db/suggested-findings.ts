import type { Database } from "bun:sqlite";
import { and, eq, isNull } from "drizzle-orm";
import { orm } from "./orm";
import { suggestedFinding, suggestionTurn } from "./schema";

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

export function recordSuggestedFindings(
  db: Database,
  itemId: string,
  findings: readonly Pick<
    SuggestedFindingRecord,
    "findingId" | "reviewId" | "location" | "severity" | "explanation"
  >[],
  now: number,
): void {
  orm(db)
    .delete(suggestedFinding)
    .where(and(eq(suggestedFinding.itemId, itemId), isNull(suggestedFinding.decision)))
    .run();
  for (const finding of findings)
    orm(db)
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
      .onConflictDoNothing({ target: [suggestedFinding.itemId, suggestedFinding.findingId] })
      .run();
}

export function suggestedFindings(db: Database, itemId: string): SuggestedFindingRecord[] {
  return orm(db)
    .select()
    .from(suggestedFinding)
    .where(eq(suggestedFinding.itemId, itemId))
    .orderBy(suggestedFinding.handedAt, suggestedFinding.findingId)
    .all() as SuggestedFindingRecord[];
}

export function decideSuggestedFindings(
  db: Database,
  itemId: string,
  decisions: ReadonlyMap<string, { decision: FindingDecision; reason: string }>,
  head: string | null,
  now: number,
): number {
  let stored = 0;
  for (const [findingId, report] of decisions)
    stored += orm(db)
      .update(suggestedFinding)
      .set({ decision: report.decision, reason: report.reason, head, decidedAt: now })
      .where(
        and(
          eq(suggestedFinding.itemId, itemId),
          eq(suggestedFinding.findingId, findingId),
          isNull(suggestedFinding.decision),
        ),
      )
      .returning({ itemId: suggestedFinding.itemId })
      .all().length;
  return stored;
}

export function recordSuggestionTurn(db: Database, record: SuggestionTurnRecord): boolean {
  return (
    orm(db)
      .insert(suggestionTurn)
      .values(record)
      .onConflictDoNothing({ target: suggestionTurn.itemId })
      .returning({ itemId: suggestionTurn.itemId })
      .all().length > 0
  );
}

export function getSuggestionTurn(db: Database, itemId: string): SuggestionTurnRecord | null {
  return (orm(db).select().from(suggestionTurn).where(eq(suggestionTurn.itemId, itemId)).get() ??
    null) as SuggestionTurnRecord | null;
}
