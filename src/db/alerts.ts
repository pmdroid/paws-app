import { and, desc, eq, gte, inArray, isNotNull, isNull, max, or, sql } from "drizzle-orm";
import { type Q } from "./db";
import { jsonItemId } from "./jobs";
import { activeRunnerIdsSteps, runnerOccupancySteps } from "./runner-capacity";

export type AlertWindows = { jobs: number; testTimeouts: number; deadOutbox: number };

export type AlertJobRow = {
  id: number;
  itemId: string;
  identifier: string | null;
  status: string;
  attempts: number;
  lastError: string | null;
  at: number;
};

export function* alertFactsSteps(q: Q, now: number, since: AlertWindows) {
  const { job, outbox, closeoutStep, workItem, workItemEvent } = q.t;
  const itemId = jsonItemId(q, sql`${job.payload}`);
  const jobs = yield* q.all(
    q.orm
      .select({
        id: job.id,
        itemId: sql<string>`${itemId}`,
        identifier: workItem.linearIdentifier,
        status: job.status,
        attempts: job.attempts,
        lastError: job.lastError,
        at: sql<number>`greatest(${job.createdAt}, coalesce(${job.finishedAt}, 0))`,
      })
      .from(job)
      .leftJoin(workItem, eq(workItem.id, itemId))
      .where(
        and(
          isNotNull(itemId),
          or(inArray(job.status, ["pending", "running"]), gte(job.finishedAt, since.jobs)),
        ),
      )
      .orderBy(desc(job.id)),
  );
  const testTimeouts = yield* q.all(
    q.orm
      .select({ finishedAt: closeoutStep.finishedAt })
      .from(closeoutStep)
      .where(
        and(
          eq(closeoutStep.stepId, "test"),
          eq(closeoutStep.timedOut, 1),
          gte(closeoutStep.finishedAt, since.testTimeouts),
        ),
      ),
  );
  const deadAt = sql<number>`greatest(${outbox.createdAt}, ${outbox.notBefore})`;
  const deadOutbox = yield* q.all(
    q.orm
      .select({ id: outbox.id, op: outbox.op, error: outbox.error, at: deadAt })
      .from(outbox)
      .where(and(eq(outbox.status, "dead"), gte(deadAt, since.deadOutbox)))
      .orderBy(outbox.id),
  );
  const queued = yield* q.one(
    q.orm.select({ id: workItem.id }).from(workItem).where(eq(workItem.state, "queued")).limit(1),
  );
  const lastQueued = yield* q.one(
    q.orm
      .select({ at: max(workItemEvent.at) })
      .from(workItemEvent)
      .where(or(eq(workItemEvent.fromState, "queued"), eq(workItemEvent.toState, "queued"))),
  );
  let freeSlots = 0;
  for (const runnerId of yield* activeRunnerIdsSteps(q, now)) {
    const occupancy = yield* runnerOccupancySteps(q, runnerId, now);
    freeSlots += Math.max(0, occupancy.capacity - occupancy.occupied);
  }
  return {
    jobs: jobs.map((row) => ({ ...row, at: Number(row.at) })) as AlertJobRow[],
    testTimeouts: testTimeouts.map((row) => Number(row.finishedAt)),
    deadOutbox: deadOutbox.map((row) => ({ ...row, at: Number(row.at) })),
    queuedNow: queued !== undefined,
    lastQueuedAt: (lastQueued?.at ?? null) === null ? null : Number(lastQueued!.at),
    freeSlots,
  };
}

export function* admittedRunnerVersionsSteps(q: Q) {
  const { runner, runnerHostStatus } = q.t;
  return yield* q.all(
    q.orm
      .select({ id: runner.id, name: runner.name, version: runnerHostStatus.runnerVersion })
      .from(runner)
      .innerJoin(runnerHostStatus, eq(runnerHostStatus.runnerId, runner.id))
      .where(and(eq(runner.status, "active"), isNull(runner.revokedAt)))
      .orderBy(runner.id),
  );
}
