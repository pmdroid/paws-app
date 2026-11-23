import { and, desc, eq, inArray, lt, max } from "drizzle-orm";
import type { Q, Steps } from "./db";
import { ulid } from "./ulid";

export const STORAGE_CLEANUP_RETENTION_MS = 90 * 86_400_000;

export type StorageCleanupPreviewRow = {
  id: string;
  machine: string;
  categories: unknown;
  items: unknown;
  kept: unknown;
  expiresAt: number;
};

export type StorageCleanupRow = {
  id: string;
  machine: string;
  actor: string;
  startedAt: number;
  finishedAt: number | null;
  categories: unknown;
  deleted: unknown;
  skipped: unknown;
  freedBytes: number;
  error: string | null;
};

export function* saveStorageCleanupPreviewSteps(
  q: Q,
  preview: Omit<StorageCleanupPreviewRow, "id">,
  now: number,
): Steps<string> {
  const table = q.t.storageCleanupPreview;
  const id = ulid(now);
  yield* q.exec(q.orm.delete(table).where(lt(table.expiresAt, now)));
  yield* q.exec(q.orm.insert(table).values({ id, ...preview }));
  return id;
}

export function* takeStorageCleanupPreviewSteps(
  q: Q,
  id: string,
): Steps<StorageCleanupPreviewRow | undefined> {
  const table = q.t.storageCleanupPreview;
  return yield* q.one(q.orm.delete(table).where(eq(table.id, id)).returning());
}

export function* startStorageCleanupSteps(
  q: Q,
  cleanup: Omit<StorageCleanupRow, "id">,
): Steps<string> {
  const table = q.t.storageCleanup;
  const id = ulid(cleanup.startedAt);
  const cutoff = cleanup.startedAt - STORAGE_CLEANUP_RETENTION_MS;
  yield* q.exec(q.orm.delete(table).where(lt(table.startedAt, cutoff)));
  yield* q.exec(q.orm.insert(table).values({ id, ...cleanup }));
  return id;
}

export function* finishStorageCleanupSteps(
  q: Q,
  id: string,
  result: Pick<StorageCleanupRow, "finishedAt" | "deleted" | "skipped" | "freedBytes" | "error">,
): Steps<void> {
  const table = q.t.storageCleanup;
  yield* q.exec(q.orm.update(table).set(result).where(eq(table.id, id)));
}

export function* listStorageCleanupsSteps(q: Q, limit: number): Steps<StorageCleanupRow[]> {
  const table = q.t.storageCleanup;
  return yield* q.all(
    q.orm.select().from(table).orderBy(desc(table.startedAt), desc(table.id)).limit(limit),
  );
}

export function* lastStorageCleanupStartedSteps(
  q: Q,
  machine: string,
  actor: string,
): Steps<number | null> {
  const table = q.t.storageCleanup;
  const row = yield* q.one(
    q.orm
      .select({ at: max(table.startedAt) })
      .from(table)
      .where(and(eq(table.machine, machine), eq(table.actor, actor))),
  );
  return row?.at ?? null;
}

export function* workItemStatesSteps(q: Q, ids: string[]): Steps<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { workItem } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ id: workItem.id, state: workItem.state })
      .from(workItem)
      .where(inArray(workItem.id, ids)),
  );
  return new Map(rows.map((row) => [row.id, row.state]));
}
