import { and, desc, eq, gt, isNull, ne, notExists, notInArray } from "drizzle-orm";
import type { Q, Steps } from "./db";
import { ulid } from "./ulid";
import { workspaceMemberUsableWhere } from "./workspace";

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
  snapshot: Omit<StorageSnapshotRow, "id"> & { id?: string },
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

export const STORAGE_REPORT_KIND = "storage.report";

export function* storageRunnersSteps(q: Q) {
  const { runner, runnerHostStatus } = q.t;
  return yield* q.all(
    q.orm
      .select({
        id: runner.id,
        name: runner.name,
        status: runner.status,
        lastSeenAt: runner.lastSeenAt,
        version: runnerHostStatus.runnerVersion,
      })
      .from(runner)
      .leftJoin(runnerHostStatus, eq(runnerHostStatus.runnerId, runner.id))
      .where(isNull(runner.revokedAt))
      .orderBy(runner.id),
  );
}

export function* connectedRunnersSteps(q: Q, seenAfter: number) {
  const { runner, workspaceMember: owner } = q.t;
  return yield* q.all(
    q.orm
      .select({ id: runner.id, workspaceId: runner.workspaceId })
      .from(runner)
      .innerJoin(
        owner,
        and(eq(owner.workspaceId, runner.workspaceId), eq(owner.userId, runner.ownerUserId)),
      )
      .where(
        and(
          isNull(runner.revokedAt),
          ne(runner.status, "revoked"),
          workspaceMemberUsableWhere(owner),
          gt(runner.lastSeenAt, seenAfter),
        ),
      )
      .orderBy(runner.id),
  );
}

export function* pendingStorageReportSteps(q: Q, runnerId: string, at: number): Steps<boolean> {
  const { runnerCommand: c, storageSnapshot: s } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: c.id })
      .from(c)
      .where(
        and(
          eq(c.runnerId, runnerId),
          eq(c.kind, STORAGE_REPORT_KIND),
          gt(c.expiresAt, at),
          isNull(c.acknowledgedAt),
          notExists(q.orm.select({ id: s.id }).from(s).where(eq(s.id, c.id))),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export function* storageReportCommandSteps(q: Q, commandId: string, runnerId: string) {
  const { runnerCommand: c, storageSnapshot: s } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ expiresAt: c.expiresAt, answered: s.id })
      .from(c)
      .leftJoin(s, eq(s.id, c.id))
      .where(and(eq(c.id, commandId), eq(c.runnerId, runnerId), eq(c.kind, STORAGE_REPORT_KIND))),
  );
  return row ? { expiresAt: row.expiresAt, answered: row.answered !== null } : null;
}
