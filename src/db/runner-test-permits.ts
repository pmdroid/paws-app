import { asc, eq, inArray } from "drizzle-orm";
import type { Db, Q, Steps } from "./db";
import { runnerLeaseLive } from "./runner-lease";

export type TestPermit = { granted: true } | { granted: false; holder: string | null };

type PermitRequest = { runId: string; runnerId: string; now: number };

export function* takeTestPermitSteps(q: Q, input: PermitRequest): Steps<TestPermit> {
  const { runner, runnerTestPermit: permit, runnerWork } = q.t;
  yield* q.all(
    q.orm.select({ id: runner.id }).from(runner).where(eq(runner.id, input.runnerId)).for("update"),
  );
  const rows = yield* q.all(
    q.orm
      .select({
        runId: permit.runId,
        requestedAt: permit.requestedAt,
        grantedAt: permit.grantedAt,
        leaseUntil: runnerWork.leaseUntil,
        endedAt: runnerWork.endedAt,
      })
      .from(permit)
      .leftJoin(runnerWork, eq(runnerWork.runId, permit.runId))
      .where(eq(permit.runnerId, input.runnerId))
      .orderBy(asc(permit.requestedAt), asc(permit.runId)),
  );
  const dead = rows.filter(
    (row) =>
      row.runId !== input.runId &&
      (row.leaseUntil === null ||
        row.endedAt !== null ||
        !runnerLeaseLive(row.leaseUntil, input.now)),
  );
  if (dead.length > 0)
    yield* q.exec(
      q.orm.delete(permit).where(
        inArray(
          permit.runId,
          dead.map((row) => row.runId),
        ),
      ),
    );
  const live = rows.filter((row) => !dead.includes(row));
  const own = live.find((row) => row.runId === input.runId);
  if (!own) {
    yield* q.exec(
      q.orm
        .insert(permit)
        .values({ runId: input.runId, runnerId: input.runnerId, requestedAt: input.now })
        .onConflictDoUpdate({
          target: permit.runId,
          set: { runnerId: input.runnerId, requestedAt: input.now, grantedAt: null },
        }),
    );
  }
  const holder = live.find((row) => row.grantedAt !== null);
  if (holder?.runId === input.runId) return { granted: true };
  if (holder) return { granted: false, holder: holder.runId };
  if ((live[0]?.runId ?? input.runId) !== input.runId) return { granted: false, holder: null };
  yield* q.exec(
    q.orm.update(permit).set({ grantedAt: input.now }).where(eq(permit.runId, input.runId)),
  );
  return { granted: true };
}

export function takeTestPermit(db: Db, input: PermitRequest): Promise<TestPermit> {
  return db.transaction((q) => takeTestPermitSteps(q, input));
}

export function* releaseTestPermitSteps(q: Q, runId: string) {
  const { runnerTestPermit: permit } = q.t;
  yield* q.exec(q.orm.delete(permit).where(eq(permit.runId, runId)));
}

export function releaseTestPermit(db: Db, runId: string): Promise<void> {
  return db.run((q) => releaseTestPermitSteps(q, runId));
}
