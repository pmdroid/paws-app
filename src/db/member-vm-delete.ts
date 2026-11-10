import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  max,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { Q, Steps } from "./db";
import { jsonField, jsonText, jsonValue } from "./json-text";

export type MemberVmTask = { itemId: string; identifier: string; title: string };
export type MemberVmRunner = { id: string; workspaceId: string; status: string };

export function* failMemberVmDeleteSteps(
  q: Q,
  id: string,
  step: string,
  failure: string,
  at: number,
) {
  const { memberVm: vm } = q.t;
  yield* q.exec(
    q.orm
      .update(vm)
      .set({ deleteFailure: failure, updatedAt: at })
      .where(and(eq(vm.id, id), eq(vm.deleteStep, step), isNull(vm.deleteFailure))),
  );
}

export function* setMemberVmDeleteRunnerSteps(q: Q, id: string, runnerId: string) {
  const { memberVm: vm } = q.t;
  yield* q.exec(
    q.orm
      .update(vm)
      .set({ deleteRunnerId: runnerId })
      .where(and(eq(vm.id, id), eq(vm.deleteStep, "drain"))),
  );
}

export function* blockMemberVmDeleteSteps(
  q: Q,
  id: string,
  failure: string,
  tasks: readonly MemberVmTask[],
  at: number,
): Steps<boolean> {
  const { memberVm: vm } = q.t;
  const changed = yield* q.all(
    q.orm
      .update(vm)
      .set({ deleteFailure: failure, deleteBlocked: jsonValue(q, tasks), updatedAt: at })
      .where(and(eq(vm.id, id), eq(vm.deleteStep, "drain"), isNull(vm.deleteFailure)))
      .returning({ id: vm.id }),
  );
  return changed.length === 1;
}

export function* runnerBlockingTasksSteps(
  q: Q,
  runnerId: string,
  leaseCutoff: number,
): Steps<MemberVmTask[]> {
  const { runnerWork: w, run: r, workItem: i } = q.t;
  const rows = yield* q.all(
    q.orm
      .selectDistinct({
        itemId: i.id,
        identifier: i.linearIdentifier,
        title: i.title,
        createdAt: r.createdAt,
      })
      .from(w)
      .innerJoin(r, eq(r.id, w.runId))
      .innerJoin(i, eq(i.id, r.itemId))
      .where(
        and(
          eq(w.runnerId, runnerId),
          or(
            and(isNull(w.endedAt), gt(w.leaseUntil, leaseCutoff)),
            inArray(r.status, ["active", "provisioning"]),
          ),
        ),
      )
      .orderBy(asc(r.createdAt), asc(i.id)),
  );
  const seen = new Set<string>();
  return rows
    .filter((row) => !seen.has(row.itemId) && seen.add(row.itemId))
    .map(({ itemId, identifier, title }) => ({ itemId, identifier: identifier!, title }));
}

export function* itemStopRequestedSteps(q: Q, itemId: string): Steps<boolean> {
  const { workItem: i } = q.t;
  const row = yield* q.one(
    q.orm.select({ requested: i.cancelRequested }).from(i).where(eq(i.id, itemId)),
  );
  return Number(row?.requested ?? 0) === 1;
}

function memberVmJob(q: Q, queue: string, id: string): SQL {
  const { job } = q.t;
  return and(eq(job.queue, queue), sql`${jsonField(q, job.payload, "memberVmId")} = ${id}`)!;
}

export function* memberVmJobRunningSteps(
  q: Q,
  queue: string,
  id: string,
  now: number,
): Steps<boolean> {
  const { job } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(job)
      .where(and(memberVmJob(q, queue, id), eq(job.status, "running"), gt(job.lockedUntil, now)))
      .limit(1),
  );
  return row !== undefined;
}

export function* revokeUnusedMemberVmEnrollmentsSteps(q: Q, id: string) {
  const { runnerEnrollment: e, memberVmEnrollment: m } = q.t;
  yield* q.exec(
    q.orm
      .delete(e)
      .where(
        and(
          isNull(e.usedAt),
          inArray(
            e.tokenHash,
            q.orm.select({ tokenHash: m.tokenHash }).from(m).where(eq(m.memberVmId, id)),
          ),
        ),
      ),
  );
}

export function* nameEnrolledRunnersSteps(
  q: Q,
  workspaceId: string,
  userId: string,
  name: string,
  since: number,
) {
  const { runnerEnrollment: e, runner } = q.t;
  return yield* q.all(
    q.orm
      .selectDistinct({ id: runner.id, name: runner.name, createdAt: runner.createdAt })
      .from(e)
      .innerJoin(runner, eq(runner.id, e.runnerId))
      .where(
        and(
          eq(e.workspaceId, workspaceId),
          eq(e.userId, userId),
          eq(e.name, name),
          gt(e.expiresAt, since),
          ne(runner.status, "revoked"),
          isNull(runner.revokedAt),
        ),
      )
      .orderBy(asc(runner.createdAt), asc(runner.id)),
  );
}

export function* pendingNameEnrollmentSteps(
  q: Q,
  workspaceId: string,
  userId: string,
  name: string,
  now: number,
): Steps<number | null> {
  const { runnerEnrollment: e } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ expiresAt: max(e.expiresAt) })
      .from(e)
      .where(
        and(
          eq(e.workspaceId, workspaceId),
          eq(e.userId, userId),
          eq(e.name, name),
          isNull(e.usedAt),
          gt(e.expiresAt, now),
        ),
      ),
  );
  return row?.expiresAt ?? null;
}

export function* memberVmEnrolledRunnerIdsSteps(q: Q, id: string): Steps<string[]> {
  const { runnerEnrollment: e, memberVmEnrollment: m } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ runnerId: e.runnerId })
      .from(m)
      .innerJoin(e, eq(e.tokenHash, m.tokenHash))
      .where(and(eq(m.memberVmId, id), isNotNull(e.runnerId))),
  );
  return rows.map((row) => row.runnerId!);
}

export function* liveRunnerSteps(q: Q, id: string): Steps<MemberVmRunner | null> {
  const { runner } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: runner.id, workspaceId: runner.workspaceId, status: runner.status })
      .from(runner)
      .where(and(eq(runner.id, id), ne(runner.status, "revoked"), isNull(runner.revokedAt))),
  );
  return row ?? null;
}

export function* advanceMemberVmDeleteSteps(
  q: Q,
  id: string,
  from: string,
  to: string,
  at: number,
): Steps<boolean> {
  const { memberVm: vm } = q.t;
  const current = yield* q.one(
    q.orm
      .select({ deleteAt: jsonText(q, vm.deleteAt) })
      .from(vm)
      .where(and(eq(vm.id, id), eq(vm.deleteStep, from), isNull(vm.deleteFailure))),
  );
  if (current === undefined) return false;
  const deleteAt = {
    ...(current.deleteAt ? (JSON.parse(current.deleteAt) as Record<string, number>) : {}),
    [to]: at,
  };
  const changed = yield* q.all(
    q.orm
      .update(vm)
      .set({
        deleteStep: to,
        deleteStepStartedAt: at,
        deleteAt: jsonValue(q, deleteAt),
        updatedAt: at,
      })
      .where(and(eq(vm.id, id), eq(vm.deleteStep, from), isNull(vm.deleteFailure)))
      .returning({ id: vm.id }),
  );
  return changed.length === 1;
}

export function* clearDeletedMemberVmSteps(
  q: Q,
  id: string,
  provisionQueue: string,
  at: number,
): Steps<boolean> {
  const { job, memberVm: vm, memberVmEnrollment: m } = q.t;
  yield* q.exec(
    q.orm
      .update(job)
      .set({
        status: "cancelled",
        finishedAt: at,
        lockedBy: null,
        lockedUntil: null,
        lastError: "member VM deleted",
      })
      .where(and(memberVmJob(q, provisionQueue, id), inArray(job.status, ["pending", "running"]))),
  );
  const removed = yield* q.all(
    q.orm
      .delete(vm)
      .where(and(eq(vm.id, id), eq(vm.deleteStep, "clear"), isNull(vm.deleteFailure)))
      .returning({ id: vm.id }),
  );
  if (removed.length !== 1) return false;
  yield* q.exec(q.orm.delete(m).where(eq(m.memberVmId, id)));
  return true;
}
