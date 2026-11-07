import type { Database } from "bun:sqlite";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { orm } from "./orm";
import {
  closeoutEvidenceObject,
  closeoutProgress,
  evidence,
  evidenceObject,
  visualReviewMark,
  workItem,
} from "./schema";

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

export function saveEvidenceObject(db: Database, row: EvidenceObject): boolean {
  return (
    orm(db)
      .insert(evidenceObject)
      .values(row)
      .onConflictDoNothing()
      .returning({ id: evidenceObject.id })
      .all().length > 0
  );
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

export type CloseoutEvidenceObject = typeof closeoutEvidenceObject.$inferSelect;

export function listCloseoutEvidenceObjects(
  db: Database,
  tasks: readonly string[],
): CloseoutEvidenceObject[] {
  if (tasks.length === 0) return [];
  return orm(db)
    .select()
    .from(closeoutEvidenceObject)
    .where(inArray(closeoutEvidenceObject.task, [...tasks]))
    .all();
}

export function getCloseoutEvidenceObject(
  db: Database,
  task: string,
  path: string,
): CloseoutEvidenceObject | null {
  return (
    orm(db)
      .select()
      .from(closeoutEvidenceObject)
      .where(and(eq(closeoutEvidenceObject.task, task), eq(closeoutEvidenceObject.path, path)))
      .get() ?? null
  );
}

export function saveCloseoutEvidenceObject(db: Database, row: CloseoutEvidenceObject): void {
  orm(db)
    .insert(closeoutEvidenceObject)
    .values(row)
    .onConflictDoUpdate({
      target: [closeoutEvidenceObject.task, closeoutEvidenceObject.path],
      set: {
        prefix: row.prefix,
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
        modifiedAt: row.modifiedAt,
        storedAt: row.storedAt,
      },
    })
    .run();
}

export function closeoutTasksOfItem(
  db: Database,
  ref: string,
  sessionIds?: readonly string[],
): string[] {
  const items = orm(db)
    .select({ id: workItem.id, sessionKey: workItem.sessionKey })
    .from(workItem)
    .where(or(eq(workItem.id, ref), eq(workItem.linearIdentifier, ref)))
    .all()
    .filter(
      (item) =>
        sessionIds === undefined ||
        (item.sessionKey !== null && sessionIds.includes(item.sessionKey)),
    )
    .map((item) => item.id);
  if (items.length === 0) return [];
  return orm(db)
    .selectDistinct({ task: closeoutProgress.taskId })
    .from(closeoutProgress)
    .where(inArray(closeoutProgress.itemId, items))
    .all()
    .map((row) => row.task);
}
