import { and, desc, eq, gt, inArray, isNull, lt, max, ne } from "drizzle-orm";
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
  pending: boolean;
  actor: string | null;
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
  preview: Omit<StorageCleanupPreviewRow, "id" | "pending" | "actor"> &
    Partial<Pick<StorageCleanupPreviewRow, "pending" | "actor">>,
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
  return yield* q.one(
    q.orm
      .delete(table)
      .where(and(eq(table.id, id), eq(table.pending, false)))
      .returning(),
  );
}

export function* readStorageCleanupPreviewSteps(
  q: Q,
  id: string,
): Steps<StorageCleanupPreviewRow | undefined> {
  const table = q.t.storageCleanupPreview;
  return yield* q.one(q.orm.select().from(table).where(eq(table.id, id)));
}

export function* answerStorageCleanupPreviewSteps(
  q: Q,
  input: { id: string; machine: string; items: unknown; kept: unknown; expiresAt: number },
  now: number,
): Steps<StorageCleanupPreviewRow | undefined> {
  const table = q.t.storageCleanupPreview;
  const { id, machine, ...answer } = input;
  return yield* q.one(
    q.orm
      .update(table)
      .set({ ...answer, pending: false })
      .where(
        and(
          eq(table.id, id),
          eq(table.machine, machine),
          eq(table.pending, true),
          gt(table.expiresAt, now),
        ),
      )
      .returning(),
  );
}

export function* storageCleanupPendingSteps(
  q: Q,
  machine: string,
  now: number,
  startedAfter: number,
): Steps<boolean> {
  const { storageCleanupPreview: preview, storageCleanup: cleanup } = q.t;
  const previewing = yield* q.one(
    q.orm
      .select({ id: preview.id })
      .from(preview)
      .where(
        and(eq(preview.machine, machine), eq(preview.pending, true), gt(preview.expiresAt, now)),
      )
      .limit(1),
  );
  if (previewing) return true;
  const running = yield* q.one(
    q.orm
      .select({ id: cleanup.id })
      .from(cleanup)
      .where(
        and(
          eq(cleanup.machine, machine),
          isNull(cleanup.finishedAt),
          gt(cleanup.startedAt, startedAfter),
        ),
      )
      .limit(1),
  );
  return running !== undefined;
}

export function* expireStorageCleanupsSteps(
  q: Q,
  input: { exceptMachine: string; startedBefore: number; now: number; error: string },
): Steps<void> {
  const table = q.t.storageCleanup;
  yield* q.exec(
    q.orm
      .update(table)
      .set({ finishedAt: input.now, error: input.error })
      .where(
        and(
          ne(table.machine, input.exceptMachine),
          isNull(table.finishedAt),
          lt(table.startedAt, input.startedBefore),
        ),
      ),
  );
}

export function* storageCleanupRunnerSteps(q: Q, runnerId: string) {
  const { runner, runnerHostStatus } = q.t;
  return yield* q.one(
    q.orm
      .select({ workspaceId: runner.workspaceId, version: runnerHostStatus.runnerVersion })
      .from(runner)
      .leftJoin(runnerHostStatus, eq(runnerHostStatus.runnerId, runner.id))
      .where(and(eq(runner.id, runnerId), isNull(runner.revokedAt), ne(runner.status, "revoked"))),
  );
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
  machine?: string,
): Steps<boolean> {
  const table = q.t.storageCleanup;
  const where = [eq(table.id, id), isNull(table.finishedAt)];
  if (machine !== undefined) where.push(eq(table.machine, machine));
  const row = yield* q.one(
    q.orm
      .update(table)
      .set(result)
      .where(and(...where))
      .returning({ id: table.id }),
  );
  return row !== undefined;
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
