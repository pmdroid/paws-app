import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { orm } from "./orm";
import { evidence } from "./schema";

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
