import type { Database } from "bun:sqlite";
import { and, desc, eq, sql } from "drizzle-orm";
import type { RiskClassification, RiskMatch, RiskTier } from "../core";
import { orm } from "./orm";
import { candidateRisk } from "./schema";

/**
 * The risk tier of one candidate head, from the paths it changes since its base commit. A head
 * with no row was not classified and must not be read as normal. `matches` names the list that
 * matched each path; a head classified before Paws recorded it has none.
 */
export type CandidateRisk = RiskClassification & {
  itemId: string;
  head: string;
  base: string;
  classifiedAt: number;
  matches?: RiskMatch[];
};

/** Records the tier for a head. A head is classified once against its base; a repeat replaces it. */
export function saveCandidateRisk(db: Database, risk: CandidateRisk): void {
  const values = {
    baseSha: risk.base,
    tier: risk.tier,
    paths: JSON.stringify(risk.paths),
    matches: risk.matches === undefined ? null : JSON.stringify(risk.matches),
    classifiedAt: risk.classifiedAt,
  };
  orm(db)
    .insert(candidateRisk)
    .values({ itemId: risk.itemId, headSha: risk.head, ...values })
    .onConflictDoUpdate({ target: [candidateRisk.itemId, candidateRisk.headSha], set: values })
    .run();
}

type Row = typeof candidateRisk.$inferSelect;

export function getCandidateRisk(db: Database, itemId: string, head: string): CandidateRisk | null {
  const row = orm(db)
    .select()
    .from(candidateRisk)
    .where(and(eq(candidateRisk.itemId, itemId), eq(candidateRisk.headSha, head)))
    .get();
  return row ? fromRow(row) : null;
}

/** The most recently classified head of the item. */
export function latestCandidateRisk(db: Database, itemId: string): CandidateRisk | null {
  const row = orm(db)
    .select()
    .from(candidateRisk)
    .where(eq(candidateRisk.itemId, itemId))
    .orderBy(desc(candidateRisk.classifiedAt), sql`rowid DESC`)
    .limit(1)
    .get();
  return row ? fromRow(row) : null;
}

function fromRow(row: Row): CandidateRisk {
  return {
    itemId: row.itemId,
    head: row.headSha,
    base: row.baseSha,
    tier: row.tier as RiskTier,
    paths: JSON.parse(row.paths) as string[],
    classifiedAt: row.classifiedAt,
    ...(row.matches === null ? {} : { matches: JSON.parse(row.matches) as RiskMatch[] }),
  };
}
