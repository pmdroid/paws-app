import type { Database } from "bun:sqlite";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import { orm } from "./orm";
import {
  closeoutEvidenceObject,
  closeoutProgress,
  evidence,
  evidenceObject,
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

export function* saveEvidenceSteps(q: Q, row: StoredEvidence) {
  const { assetUrl: _, ...values } = row;
  yield* q.exec(q.orm.insert(q.t.evidence).values(values));
}

export function saveEvidence(db: Database, row: StoredEvidence): void {
  const { assetUrl: _, ...values } = row;
  orm(db).insert(evidence).values(values).run();
}

export function* getEvidenceSteps(q: Q, id: string) {
  const row = yield* q.one(q.orm.select().from(q.t.evidence).where(eq(q.t.evidence.id, id)));
  return (row ?? null) as StoredEvidence | null;
}

export function* listEvidenceSteps(q: Q, itemId: string) {
  const rows = yield* q.all(
    q.orm
      .select()
      .from(q.t.evidence)
      .where(eq(q.t.evidence.itemId, itemId))
      .orderBy(q.t.evidence.createdAt, q.t.evidence.id),
  );
  return rows as StoredEvidence[];
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

export function* setEvidenceAssetUrlSteps(q: Q, id: string, assetUrl: string) {
  const { evidence: table } = q.t;
  yield* q.exec(q.orm.update(table).set({ assetUrl }).where(eq(table.id, id)));
}

export type EvidenceObject = typeof evidenceObject.$inferSelect;

export function* saveEvidenceObjectSteps(q: Q, row: EvidenceObject) {
  const inserted = yield* q.all(
    q.orm
      .insert(q.t.evidenceObject)
      .values(row)
      .onConflictDoNothing()
      .returning({ id: q.t.evidenceObject.id }),
  );
  return inserted.length > 0;
}

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

export function* getEvidenceObjectSteps(q: Q, id: string) {
  const { evidenceObject: o } = q.t;
  const row = yield* q.one(q.orm.select().from(o).where(eq(o.id, id)));
  return (row as EvidenceObject | undefined) ?? null;
}

export function getEvidenceObject(db: Database, id: string): EvidenceObject | null {
  return settled(sqliteDb(db).run((q) => getEvidenceObjectSteps(q, id)));
}

export function* deleteEvidenceObjectSteps(q: Q, id: string) {
  const { evidenceObject: o } = q.t;
  yield* q.exec(q.orm.delete(o).where(eq(o.id, id)));
}

export function deleteEvidenceObject(db: Database, id: string): void {
  settled(sqliteDb(db).run((q) => deleteEvidenceObjectSteps(q, id)));
}

export function* localEvidenceFilesSteps(q: Q) {
  const { evidence: e, evidenceObject: o, visualReviewMark: mark } = q.t;
  const columns = { itemId: e.itemId, headCommit: e.headCommit, checkId: e.checkId };
  const files = yield* q.all(
    q.orm
      .select({ id: e.id, ...columns })
      .from(e)
      .leftJoin(o, eq(o.id, e.id))
      .where(isNull(o.id)),
  );
  const marks = yield* q.all(
    q.orm
      .select({ id: mark.id, ...columns })
      .from(mark)
      .innerJoin(e, eq(e.id, mark.evidenceId))
      .leftJoin(o, eq(o.id, mark.id))
      .where(isNull(o.id)),
  );
  return [...files, ...marks];
}

export function localEvidenceFiles(
  db: Database,
): { id: string; itemId: string; headCommit: string; checkId: string }[] {
  return settled(sqliteDb(db).run((q) => localEvidenceFilesSteps(q)));
}

export type CloseoutEvidenceObject = typeof closeoutEvidenceObject.$inferSelect;

export function* listCloseoutEvidenceObjectsSteps(q: Q, tasks: readonly string[]) {
  if (tasks.length === 0) return [];
  return yield* q.all(
    q.orm
      .select()
      .from(q.t.closeoutEvidenceObject)
      .where(inArray(q.t.closeoutEvidenceObject.task, [...tasks])),
  );
}

export function* getCloseoutEvidenceObjectSteps(q: Q, task: string, path: string) {
  const row = yield* q.one(
    q.orm
      .select()
      .from(q.t.closeoutEvidenceObject)
      .where(
        and(eq(q.t.closeoutEvidenceObject.task, task), eq(q.t.closeoutEvidenceObject.path, path)),
      ),
  );
  return row ?? null;
}

export function* saveCloseoutEvidenceObjectSteps(q: Q, row: CloseoutEvidenceObject) {
  yield* q.exec(
    q.orm
      .insert(q.t.closeoutEvidenceObject)
      .values(row)
      .onConflictDoUpdate({
        target: [q.t.closeoutEvidenceObject.task, q.t.closeoutEvidenceObject.path],
        set: {
          prefix: row.prefix,
          sizeBytes: row.sizeBytes,
          sha256: row.sha256,
          modifiedAt: row.modifiedAt,
          storedAt: row.storedAt,
        },
      }),
  );
}

export function* insertCloseoutEvidenceObjectSteps(q: Q, row: CloseoutEvidenceObject) {
  const inserted = yield* q.all(
    q.orm
      .insert(q.t.closeoutEvidenceObject)
      .values(row)
      .onConflictDoNothing()
      .returning({ task: q.t.closeoutEvidenceObject.task }),
  );
  return inserted.length > 0;
}

export function* closeoutTasksOfItemSteps(q: Q, ref: string, sessionIds?: readonly string[]) {
  const rows = yield* q.all(
    q.orm
      .select({ id: q.t.workItem.id, sessionKey: q.t.workItem.sessionKey })
      .from(q.t.workItem)
      .where(or(eq(q.t.workItem.id, ref), eq(q.t.workItem.linearIdentifier, ref))),
  );
  const items = rows
    .filter(
      (item) =>
        sessionIds === undefined ||
        (item.sessionKey !== null && sessionIds.includes(item.sessionKey)),
    )
    .map((item) => item.id);
  if (items.length === 0) return [];
  const tasks = yield* q.all(
    q.orm
      .selectDistinct({ task: q.t.closeoutProgress.taskId })
      .from(q.t.closeoutProgress)
      .where(inArray(q.t.closeoutProgress.itemId, items)),
  );
  return tasks.map((row) => row.task);
}

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

export function insertCloseoutEvidenceObject(db: Database, row: CloseoutEvidenceObject): boolean {
  return (
    orm(db)
      .insert(closeoutEvidenceObject)
      .values(row)
      .onConflictDoNothing()
      .returning({ task: closeoutEvidenceObject.task })
      .all().length > 0
  );
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
