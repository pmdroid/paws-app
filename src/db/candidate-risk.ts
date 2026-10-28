import type { Database } from "bun:sqlite";
import type { RiskClassification, RiskMatch, RiskTier } from "../core";

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
  db.run(
    `INSERT INTO candidate_risk (item_id, head_sha, base_sha, tier, paths, matches, classified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (item_id, head_sha) DO UPDATE SET
       base_sha = excluded.base_sha, tier = excluded.tier, paths = excluded.paths,
       matches = excluded.matches, classified_at = excluded.classified_at`,
    [
      risk.itemId,
      risk.head,
      risk.base,
      risk.tier,
      JSON.stringify(risk.paths),
      risk.matches === undefined ? null : JSON.stringify(risk.matches),
      risk.classifiedAt,
    ],
  );
}

type Row = {
  itemId: string;
  head: string;
  base: string;
  tier: RiskTier;
  paths: string;
  matches: string | null;
  classifiedAt: number;
};

const SELECT = `SELECT item_id AS itemId, head_sha AS head, base_sha AS base, tier, paths,
  matches, classified_at AS classifiedAt FROM candidate_risk`;

export function getCandidateRisk(db: Database, itemId: string, head: string): CandidateRisk | null {
  const row = db
    .query<Row, [string, string]>(`${SELECT} WHERE item_id = ? AND head_sha = ?`)
    .get(itemId, head);
  return row ? fromRow(row) : null;
}

/** The most recently classified head of the item. */
export function latestCandidateRisk(db: Database, itemId: string): CandidateRisk | null {
  const row = db
    .query<Row, [string]>(
      `${SELECT} WHERE item_id = ? ORDER BY classified_at DESC, rowid DESC LIMIT 1`,
    )
    .get(itemId);
  return row ? fromRow(row) : null;
}

function fromRow({ matches, ...row }: Row): CandidateRisk {
  return {
    ...row,
    paths: JSON.parse(row.paths) as string[],
    ...(matches === null ? {} : { matches: JSON.parse(matches) as RiskMatch[] }),
  };
}
