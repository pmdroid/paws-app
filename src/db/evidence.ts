import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { type Q, type Db } from "./db";
import { closeoutEvidenceObject, evidenceObject } from "./schema";

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

export async function saveEvidence(store: Db, row: StoredEvidence): Promise<void> {
  await store.run((q) => saveEvidenceSteps(q, row));
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

export async function getEvidence(store: Db, id: string): Promise<StoredEvidence | null> {
  return store.run((q) => getEvidenceSteps(q, id));
}

export async function listEvidence(store: Db, itemId: string): Promise<StoredEvidence[]> {
  return store.run((q) => listEvidenceSteps(q, itemId));
}

export function latestEvidence(rows: readonly StoredEvidence[]): StoredEvidence[] {
  const latest = new Map<string, StoredEvidence>();
  for (const row of rows)
    latest.set(JSON.stringify([row.checkId, row.displayName, row.headCommit]), row);
  return [...latest.values()];
}

export async function setEvidenceAssetUrl(store: Db, id: string, assetUrl: string): Promise<void> {
  await store.run((q) => setEvidenceAssetUrlSteps(q, id, assetUrl));
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

export async function saveEvidenceObject(store: Db, row: EvidenceObject): Promise<boolean> {
  return store.run((q) => saveEvidenceObjectSteps(q, row));
}

export function* getEvidenceObjectSteps(q: Q, id: string) {
  const { evidenceObject: o } = q.t;
  const row = yield* q.one(q.orm.select().from(o).where(eq(o.id, id)));
  return (row as EvidenceObject | undefined) ?? null;
}

export async function getEvidenceObject(store: Db, id: string): Promise<EvidenceObject | null> {
  return store.run((q) => getEvidenceObjectSteps(q, id));
}

export function* deleteEvidenceObjectSteps(q: Q, id: string) {
  const { evidenceObject: o } = q.t;
  yield* q.exec(q.orm.delete(o).where(eq(o.id, id)));
}

export async function deleteEvidenceObject(store: Db, id: string): Promise<void> {
  await store.run((q) => deleteEvidenceObjectSteps(q, id));
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

export async function localEvidenceFiles(
  store: Db,
): Promise<{ id: string; itemId: string; headCommit: string; checkId: string }[]> {
  return store.run((q) => localEvidenceFilesSteps(q));
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

export async function listCloseoutEvidenceObjects(
  store: Db,
  tasks: readonly string[],
): Promise<CloseoutEvidenceObject[]> {
  return store.run((q) => listCloseoutEvidenceObjectsSteps(q, tasks));
}

export async function getCloseoutEvidenceObject(
  store: Db,
  task: string,
  path: string,
): Promise<CloseoutEvidenceObject | null> {
  return store.run((q) => getCloseoutEvidenceObjectSteps(q, task, path));
}

export async function saveCloseoutEvidenceObject(
  store: Db,
  row: CloseoutEvidenceObject,
): Promise<void> {
  await store.run((q) => saveCloseoutEvidenceObjectSteps(q, row));
}

export async function insertCloseoutEvidenceObject(
  store: Db,
  row: CloseoutEvidenceObject,
): Promise<boolean> {
  return store.run((q) => insertCloseoutEvidenceObjectSteps(q, row));
}

export async function closeoutTasksOfItem(
  store: Db,
  ref: string,
  sessionIds?: readonly string[],
): Promise<string[]> {
  return store.run((q) => closeoutTasksOfItemSteps(q, ref, sessionIds));
}
