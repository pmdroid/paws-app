import type { Database } from "bun:sqlite";
import { and, desc, eq, sql } from "drizzle-orm";
import { orm } from "./orm";
import { riskFix } from "./schema";

/**
 * What a fix changed on a high-risk pull request since the head a person approved. `paths` are
 * the changed files a high-risk glob matched: empty means the approval carried over to `head`,
 * otherwise Paws asks again about those paths only.
 */
export type RiskFix = {
  itemId: string;
  head: string;
  approvedHead: string;
  /** The risk link ask whose approval this head was compared with. */
  approvedQuestionId: string;
  /** Every file the fix changed since the approved head, sorted. */
  changed: string[];
  paths: string[];
  recordedAt: number;
};

/** Records the comparison for a head. A repeat for the same head replaces it. */
export function saveRiskFix(db: Database, fix: RiskFix): void {
  const values = {
    approvedHead: fix.approvedHead,
    approvedQuestionId: fix.approvedQuestionId,
    changed: JSON.stringify(fix.changed),
    paths: JSON.stringify(fix.paths),
    recordedAt: fix.recordedAt,
  };
  orm(db)
    .insert(riskFix)
    .values({ itemId: fix.itemId, headSha: fix.head, ...values })
    .onConflictDoUpdate({ target: [riskFix.itemId, riskFix.headSha], set: values })
    .run();
}

/** Forgets the comparison for a head, as when Paws can no longer read the fix. */
export function deleteRiskFix(db: Database, itemId: string, head: string): void {
  orm(db)
    .delete(riskFix)
    .where(and(eq(riskFix.itemId, itemId), eq(riskFix.headSha, head)))
    .run();
}

type Row = typeof riskFix.$inferSelect;

export function getRiskFix(db: Database, itemId: string, head: string): RiskFix | null {
  const row = orm(db)
    .select()
    .from(riskFix)
    .where(and(eq(riskFix.itemId, itemId), eq(riskFix.headSha, head)))
    .get();
  return row ? fromRow(row) : null;
}

/** The most recently recorded fix of the item. */
export function latestRiskFix(db: Database, itemId: string): RiskFix | null {
  const row = orm(db)
    .select()
    .from(riskFix)
    .where(eq(riskFix.itemId, itemId))
    .orderBy(desc(riskFix.recordedAt), sql`rowid DESC`)
    .limit(1)
    .get();
  return row ? fromRow(row) : null;
}

function fromRow(row: Row): RiskFix {
  return {
    itemId: row.itemId,
    head: row.headSha,
    approvedHead: row.approvedHead,
    approvedQuestionId: row.approvedQuestionId,
    changed: JSON.parse(row.changed) as string[],
    paths: JSON.parse(row.paths) as string[],
    recordedAt: row.recordedAt,
  };
}
