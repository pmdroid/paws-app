import { and, desc, eq, notInArray } from "drizzle-orm";
import type { Q, Steps } from "./db";
import { ulid } from "./ulid";

export const STORAGE_SNAPSHOTS_KEPT = 30;

export type StorageSnapshotRow = {
  id: string;
  machine: string;
  takenAt: number;
  partial: boolean;
  filesystems: unknown;
  categories: unknown;
};

export function* saveStorageSnapshotSteps(
  q: Q,
  snapshot: Omit<StorageSnapshotRow, "id">,
): Steps<void> {
  const table = q.t.storageSnapshot;
  const row = { id: ulid(snapshot.takenAt), ...snapshot };
  yield* q.exec(q.orm.insert(table).values(row));
  const kept = yield* q.all(
    q.orm
      .select({ id: table.id })
      .from(table)
      .where(eq(table.machine, row.machine))
      .orderBy(desc(table.takenAt), desc(table.id))
      .limit(STORAGE_SNAPSHOTS_KEPT),
  );
  yield* q.exec(
    q.orm.delete(table).where(
      and(
        eq(table.machine, row.machine),
        notInArray(
          table.id,
          kept.map((entry) => entry.id),
        ),
      ),
    ),
  );
}

export function* latestStorageSnapshotsSteps(q: Q): Steps<StorageSnapshotRow[]> {
  const table = q.t.storageSnapshot;
  const machines = yield* q.all(q.orm.selectDistinct({ machine: table.machine }).from(table));
  const rows: StorageSnapshotRow[] = [];
  for (const { machine } of machines) {
    const row = yield* q.one(
      q.orm
        .select()
        .from(table)
        .where(eq(table.machine, machine))
        .orderBy(desc(table.takenAt), desc(table.id))
        .limit(1),
    );
    if (row) rows.push(row);
  }
  return rows.sort((a, b) => a.machine.localeCompare(b.machine));
}
