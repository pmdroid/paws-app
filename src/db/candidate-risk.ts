import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { RiskClassification, RiskMatch, RiskTier } from "../core";
import { type Q, type Db } from "./db";
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

export function* saveCandidateRiskSteps(
  q: Q,
  risk: CandidateRisk & { changedPaths?: readonly string[]; recordedAt?: number },
) {
  const { candidateRisk } = q.t;
  const values = {
    baseSha: risk.base,
    tier: risk.tier,
    paths: jsonValue(q, risk.paths),
    matches: risk.matches === undefined ? null : jsonValue(q, risk.matches),
    classifiedAt: risk.classifiedAt,
    ...(risk.changedPaths === undefined
      ? {}
      : {
          changedPaths: jsonValue(q, [...new Set(risk.changedPaths)].sort()),
          recordedAt: risk.recordedAt ?? risk.classifiedAt,
        }),
  };
  yield* q.exec(
    q.orm
      .insert(candidateRisk)
      .values({ itemId: risk.itemId, headSha: risk.head, ...values })
      .onConflictDoUpdate({ target: [candidateRisk.itemId, candidateRisk.headSha], set: values }),
  );
}

type Row = typeof candidateRisk.$inferSelect;

export function* getCandidateRiskSteps(q: Q, itemId: string, head: string) {
  const { candidateRisk } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(candidateRisk)
      .where(
        and(
          eq(candidateRisk.itemId, itemId),
          eq(candidateRisk.headSha, head),
          isNotNull(candidateRisk.tier),
        ),
      ),
  );
  return row ? fromRow(q, row) : null;
}

export async function getCandidateRisk(
  store: Db,
  itemId: string,
  head: string,
): Promise<CandidateRisk | null> {
  return store.run((q) => getCandidateRiskSteps(q, itemId, head));
}

/** Ties on `classified_at` go to the greater head SHA. */
export function* latestCandidateRiskSteps(q: Q, itemId: string) {
  const { candidateRisk } = q.t;
  const row = yield* q.one(
    q.orm
      .select()
      .from(candidateRisk)
      .where(and(eq(candidateRisk.itemId, itemId), isNotNull(candidateRisk.tier)))
      .orderBy(desc(candidateRisk.classifiedAt), desc(candidateRisk.headSha))
      .limit(1),
  );
  return row ? fromRow(q, row) : null;
}

export function* latestCandidateRisksSteps(q: Q, itemIds: readonly string[]) {
  const { candidateRisk } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(candidateRisk)
      .where(and(inArray(candidateRisk.itemId, [...itemIds]), isNotNull(candidateRisk.tier)))
      .orderBy(desc(candidateRisk.classifiedAt), desc(candidateRisk.headSha)),
  );
  const latest = new Map<string, CandidateRisk>();
  for (const row of rows) if (!latest.has(row.itemId)) latest.set(row.itemId, fromRow(q, row));
  return latest;
}

/** The most recently classified head of the item. */
export async function latestCandidateRisk(
  store: Db,
  itemId: string,
): Promise<CandidateRisk | null> {
  return store.run((q) => latestCandidateRiskSteps(q, itemId));
}

function fromRow(q: Q, row: Row): CandidateRisk {
  if (row.baseSha === null || row.tier === null || row.paths === null || row.classifiedAt === null)
    throw new Error("Incomplete stored candidate classification");
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
