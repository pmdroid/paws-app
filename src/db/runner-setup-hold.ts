import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { enqueueJob } from "./jobs";
import { orm } from "./orm";
import { job } from "./schema";
import { settled, sqliteDb, type Q, type Steps } from "./db";

/**
 * A queued item held because its delegator has no runner Paws may use. The scheduler skips it,
 * nothing retries it, and no start timeout applies. Migration 139 deletes the row when the item
 * leaves the queue or a Stop is requested.
 */
export type RunnerSetupHold = {
  itemId: string;
  ownerUserId: string | null;
  reason: "no-runner" | "agent-not-signed-in";
  runnerId: string | null;
  agent: string | null;
  /** The run the hold stopped, which the resume picks up again. */
  runId: string | null;
  since: number;
  notifiedAt: number | null;
};

function holdColumns(q: Q) {
  const { runnerSetupHold } = q.t;
  return {
    itemId: runnerSetupHold.itemId,
    ownerUserId: runnerSetupHold.ownerUserId,
    reason: sql<RunnerSetupHold["reason"]>`${runnerSetupHold.reason}`,
    runnerId: runnerSetupHold.runnerId,
    agent: runnerSetupHold.agent,
    runId: runnerSetupHold.runId,
    since: runnerSetupHold.since,
    notifiedAt: runnerSetupHold.notifiedAt,
  };
}

export function* getRunnerSetupHoldSteps(q: Q, itemId: string): Steps<RunnerSetupHold | null> {
  const { runnerSetupHold } = q.t;
  const row = yield* q.one(
    q.orm.select(holdColumns(q)).from(runnerSetupHold).where(eq(runnerSetupHold.itemId, itemId)),
  );
  return row ?? null;
}

export function getRunnerSetupHold(db: Database, itemId: string): RunnerSetupHold | null {
  return settled(sqliteDb(db).run((q) => getRunnerSetupHoldSteps(q, itemId)));
}

export function* listRunnerSetupHoldsSteps(q: Q, ownerUserId?: string): Steps<RunnerSetupHold[]> {
  const { runnerSetupHold } = q.t;
  return yield* q.all(
    q.orm
      .select(holdColumns(q))
      .from(runnerSetupHold)
      .where(ownerUserId === undefined ? undefined : eq(runnerSetupHold.ownerUserId, ownerUserId))
      .orderBy(asc(runnerSetupHold.since), asc(runnerSetupHold.itemId)),
  );
}

export function listRunnerSetupHolds(db: Database, ownerUserId?: string): RunnerSetupHold[] {
  return settled(sqliteDb(db).run((q) => listRunnerSetupHoldsSteps(q, ownerUserId)));
}

type HoldInput = {
  itemId: string;
  ownerUserId: string | null;
  reason: RunnerSetupHold["reason"];
  runnerId?: string | null;
  agent?: string | null;
  runId?: string | null;
  now: number;
};

export function* holdForRunnerSetupSteps(q: Q, input: HoldInput): Steps<RunnerSetupHold> {
  const { runnerSetupHold } = q.t;
  const hold = {
    ownerUserId: input.ownerUserId,
    reason: input.reason,
    runnerId: input.runnerId ?? null,
    agent: input.agent ?? null,
  };
  yield* q.exec(
    q.orm
      .insert(runnerSetupHold)
      .values({ itemId: input.itemId, ...hold, runId: input.runId ?? null, since: input.now })
      .onConflictDoUpdate({
        target: runnerSetupHold.itemId,
        set: { ...hold, runId: sql`COALESCE(excluded.run_id,${runnerSetupHold.runId})` },
      }),
  );
  return (yield* getRunnerSetupHoldSteps(q, input.itemId))!;
}

/**
 * Hold a queued item for runner setup. A hold that already exists keeps its `since` and
 * `notified_at` and takes the latest reason. Call inside the transaction that queues the item.
 */
export function holdForRunnerSetup(db: Database, input: HoldInput): RunnerSetupHold {
  return settled(sqliteDb(db).run((q) => holdForRunnerSetupSteps(q, input)));
}

export function* markRunnerSetupNotifiedSteps(q: Q, itemId: string, now: number): Steps<void> {
  const { runnerSetupHold } = q.t;
  yield* q.exec(
    q.orm
      .update(runnerSetupHold)
      .set({ notifiedAt: now })
      .where(and(eq(runnerSetupHold.itemId, itemId), isNull(runnerSetupHold.notifiedAt))),
  );
}

export function markRunnerSetupNotified(db: Database, itemId: string, now: number): void {
  settled(sqliteDb(db).run((q) => markRunnerSetupNotifiedSteps(q, itemId, now)));
}

export function* releaseRunnerSetupHoldSteps(q: Q, itemId: string, now?: number): Steps<boolean> {
  const { runnerSetupHold, runnerSetupResume } = q.t;
  const hold = yield* getRunnerSetupHoldSteps(q, itemId);
  if (!hold) return false;
  const deleted = yield* q.all(
    q.orm
      .delete(runnerSetupHold)
      .where(eq(runnerSetupHold.itemId, itemId))
      .returning({ itemId: runnerSetupHold.itemId }),
  );
  if (deleted.length === 0) return false;
  if (hold.runId !== null && now !== undefined)
    yield* q.exec(
      q.orm
        .insert(runnerSetupResume)
        .values({ itemId, runId: hold.runId, releasedAt: now })
        .onConflictDoUpdate({
          target: runnerSetupResume.itemId,
          set: { runId: hold.runId, releasedAt: now },
        }),
    );
  return true;
}

/**
 * End a hold, for the resume that starts the item again. A hold that stopped a run leaves that
 * run for `takeRunnerSetupResume`. False when the hold was already gone, so two checks at once
 * resume the item once. Call inside the transaction that posts the resume.
 */
export function releaseRunnerSetupHold(db: Database, itemId: string, now?: number): boolean {
  return settled(sqliteDb(db).run((q) => releaseRunnerSetupHoldSteps(q, itemId, now)));
}

export function* takeRunnerSetupResumeSteps(q: Q, itemId: string, runId: string): Steps<boolean> {
  const { runnerSetupResume } = q.t;
  const row = yield* q.one(
    q.orm
      .delete(runnerSetupResume)
      .where(eq(runnerSetupResume.itemId, itemId))
      .returning({ runId: runnerSetupResume.runId }),
  );
  return row?.runId === runId;
}

/**
 * Whether `runId` is the run a released runner-setup hold stopped, so the start continues it
 * instead of opening a new one. Consumes the record either way.
 */
export function takeRunnerSetupResume(db: Database, itemId: string, runId: string): boolean {
  return settled(sqliteDb(db).run((q) => takeRunnerSetupResumeSteps(q, itemId, runId)));
}

/**
 * Queue one `runner_setup.check` job for `ownerUserId` unless one is already pending, the same
 * rule the triggers of migration 144 follow.
 */
export function enqueueRunnerSetupCheck(db: Database, ownerUserId: string, now: number): void {
  const pending = orm(db)
    .select({ one: sql`1` })
    .from(job)
    .where(
      and(
        eq(job.queue, JOB_KIND.runnerSetupCheck),
        eq(job.status, "pending"),
        sql`json_extract(${job.payload},'$.ownerUserId') = ${ownerUserId}`,
      ),
    )
    .limit(1)
    .get();
  if (pending) return;
  enqueueJob(db, {
    queue: JOB_KIND.runnerSetupCheck,
    payload: { ownerUserId },
    maxAttempts: 3,
    now,
  });
}
