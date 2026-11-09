import type { Database } from "bun:sqlite";
import { and, desc, eq } from "drizzle-orm";
import type { RiskClassification, RiskMatch, RiskTier } from "../core";
import { settled, sqliteDb, type Q } from "./db";
import { jsonValue, parsedJson } from "./json-text";
import type { candidateRisk } from "./schema-pg";

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

export function* saveCandidateRiskSteps(q: Q, risk: CandidateRisk) {
  const { candidateRisk } = q.t;
  const values = {
    baseSha: risk.base,
    tier: risk.tier,
    paths: jsonValue(q, risk.paths),
    matches: risk.matches === undefined ? null : jsonValue(q, risk.matches),
    classifiedAt: risk.classifiedAt,
  };
  yield* q.exec(
    q.orm
      .insert(candidateRisk)
      .values({ itemId: risk.itemId, headSha: risk.head, ...values })
      .onConflictDoUpdate({ target: [candidateRisk.itemId, candidateRisk.headSha], set: values }),
  );
}

/** Records the tier for a head. A head is classified once against its base; a repeat replaces it. */
export function saveCandidateRisk(db: Database, risk: CandidateRisk): void {
  settled(sqliteDb(db).run((q) => saveCandidateRiskSteps(q, risk)));
}

type Row = typeof candidateRisk.$inferSelect;

export function* getCandidateRiskSteps(q: Q, itemId: string, head: string) {
  const { candidateRisk } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(candidateRisk)
      .where(and(eq(candidateRisk.itemId, itemId), eq(candidateRisk.headSha, head))),
  );
  return row ? fromRow(q, row) : null;
}

export function getCandidateRisk(db: Database, itemId: string, head: string): CandidateRisk | null {
  return settled(sqliteDb(db).run((q) => getCandidateRiskSteps(q, itemId, head)));
}

/** Ties on `classified_at` go to the greater head SHA. */
export function* latestCandidateRiskSteps(q: Q, itemId: string) {
  const { candidateRisk } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(candidateRisk)
      .where(eq(candidateRisk.itemId, itemId))
      .orderBy(desc(candidateRisk.classifiedAt), desc(candidateRisk.headSha))
      .limit(1),
  );
  return row ? fromRow(q, row) : null;
}

/** The most recently classified head of the item. */
export function latestCandidateRisk(db: Database, itemId: string): CandidateRisk | null {
  return settled(sqliteDb(db).run((q) => latestCandidateRiskSteps(q, itemId)));
}

function fromRow(q: Q, row: Row): CandidateRisk {
  return {
    itemId: row.itemId,
    head: row.headSha,
    base: row.baseSha,
    tier: row.tier as RiskTier,
    paths: parsedJson<string[]>(q, row.paths),
    classifiedAt: row.classifiedAt,
    ...(row.matches === null ? {} : { matches: parsedJson<RiskMatch[]>(q, row.matches) }),
  };
}
