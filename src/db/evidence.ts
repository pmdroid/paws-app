import type { Database } from "bun:sqlite";
import { eq, isNull } from "drizzle-orm";
import { orm } from "./orm";
import { evidence, evidenceObject, visualReviewMark } from "./schema";

export type EvidenceMediaType =
  | "video/webm"
  | "video/mp4"
  | "image/png"
  | "image/jpeg"
  | "image/webp";

export type StoredEvidence = {
  id: string;
  itemId: string;
  runId: string;
  checkId: string;
  attempt: number;
  mediaType: EvidenceMediaType;
  sizeBytes: number;
  sha256: string;
  displayName: string;
  headCommit: string;
  createdAt: number;
  /** The Linear upload of this file, once Paws has put it there. */
  assetUrl?: string | null;
};

export function saveEvidence(db: Database, row: StoredEvidence): void {
  const { assetUrl: _, ...values } = row;
  orm(db).insert(evidence).values(values).run();
}

export function getEvidence(db: Database, id: string): StoredEvidence | null {
  return (orm(db).select().from(evidence).where(eq(evidence.id, id)).get() ??
    null) as StoredEvidence | null;
}

export function listEvidence(db: Database, itemId: string): StoredEvidence[] {
  return orm(db)
    .select()
    .from(evidence)
    .where(eq(evidence.itemId, itemId))
    .orderBy(evidence.createdAt, evidence.id)
    .all() as StoredEvidence[];
}

export function latestEvidence(rows: readonly StoredEvidence[]): StoredEvidence[] {
  const latest = new Map<string, StoredEvidence>();
  for (const row of rows)
    latest.set(JSON.stringify([row.checkId, row.displayName, row.headCommit]), row);
  return [...latest.values()];
}

export function setEvidenceAssetUrl(db: Database, id: string, assetUrl: string): void {
  orm(db).update(evidence).set({ assetUrl }).where(eq(evidence.id, id)).run();
}

export type EvidenceObject = typeof evidenceObject.$inferSelect;

export function saveEvidenceObject(db: Database, row: EvidenceObject): void {
  orm(db).insert(evidenceObject).values(row).onConflictDoNothing().run();
}

export function getEvidenceObject(db: Database, id: string): EvidenceObject | null {
  return orm(db).select().from(evidenceObject).where(eq(evidenceObject.id, id)).get() ?? null;
}

export function deleteEvidenceObject(db: Database, id: string): void {
  orm(db).delete(evidenceObject).where(eq(evidenceObject.id, id)).run();
}

export function localEvidenceFiles(
  db: Database,
): { id: string; itemId: string; headCommit: string; checkId: string }[] {
  const columns = {
    itemId: evidence.itemId,
    headCommit: evidence.headCommit,
    checkId: evidence.checkId,
  };
  const files = orm(db)
    .select({ id: evidence.id, ...columns })
    .from(evidence)
    .leftJoin(evidenceObject, eq(evidenceObject.id, evidence.id))
    .where(isNull(evidenceObject.id))
    .all();
  const marks = orm(db)
    .select({ id: visualReviewMark.id, ...columns })
    .from(visualReviewMark)
    .innerJoin(evidence, eq(evidence.id, visualReviewMark.evidenceId))
    .leftJoin(evidenceObject, eq(evidenceObject.id, visualReviewMark.id))
    .where(isNull(evidenceObject.id))
    .all();
  return [...files, ...marks];
}
