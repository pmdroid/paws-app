import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { enqueueJob } from "./jobs";
import { orm } from "./orm";
import { job, runnerSetupHold, runnerSetupResume } from "./schema";

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

const HOLD = {
  itemId: runnerSetupHold.itemId,
  ownerUserId: runnerSetupHold.ownerUserId,
  reason: sql<RunnerSetupHold["reason"]>`${runnerSetupHold.reason}`,
  runnerId: runnerSetupHold.runnerId,
  agent: runnerSetupHold.agent,
  runId: runnerSetupHold.runId,
  since: runnerSetupHold.since,
  notifiedAt: runnerSetupHold.notifiedAt,
};

export function getRunnerSetupHold(db: Database, itemId: string): RunnerSetupHold | null {
  return (
    orm(db).select(HOLD).from(runnerSetupHold).where(eq(runnerSetupHold.itemId, itemId)).get() ??
    null
  );
}

export function listRunnerSetupHolds(db: Database, ownerUserId?: string): RunnerSetupHold[] {
  return orm(db)
    .select(HOLD)
    .from(runnerSetupHold)
    .where(ownerUserId === undefined ? undefined : eq(runnerSetupHold.ownerUserId, ownerUserId))
    .orderBy(asc(runnerSetupHold.since), asc(runnerSetupHold.itemId))
    .all();
}

/**
 * Hold a queued item for runner setup. A hold that already exists keeps its `since` and
 * `notified_at` and takes the latest reason. Call inside the transaction that queues the item.
 */
export function holdForRunnerSetup(
  db: Database,
  input: {
    itemId: string;
    ownerUserId: string | null;
    reason: RunnerSetupHold["reason"];
    runnerId?: string | null;
    agent?: string | null;
    runId?: string | null;
    now: number;
  },
): RunnerSetupHold {
  const hold = {
    ownerUserId: input.ownerUserId,
    reason: input.reason,
    runnerId: input.runnerId ?? null,
    agent: input.agent ?? null,
  };
  orm(db)
    .insert(runnerSetupHold)
    .values({ itemId: input.itemId, ...hold, runId: input.runId ?? null, since: input.now })
    .onConflictDoUpdate({
      target: runnerSetupHold.itemId,
      set: { ...hold, runId: sql`COALESCE(excluded.run_id,${runnerSetupHold.runId})` },
    })
    .run();
  return getRunnerSetupHold(db, input.itemId)!;
}

export function markRunnerSetupNotified(db: Database, itemId: string, now: number): void {
  orm(db)
    .update(runnerSetupHold)
    .set({ notifiedAt: now })
    .where(and(eq(runnerSetupHold.itemId, itemId), isNull(runnerSetupHold.notifiedAt)))
    .run();
}

/**
 * End a hold, for the resume that starts the item again. A hold that stopped a run leaves that
 * run for `takeRunnerSetupResume`. False when the hold was already gone, so two checks at once
 * resume the item once. Call inside the transaction that posts the resume.
 */
export function releaseRunnerSetupHold(db: Database, itemId: string, now?: number): boolean {
  const hold = getRunnerSetupHold(db, itemId);
  if (!hold) return false;
  const deleted = orm(db)
    .delete(runnerSetupHold)
    .where(eq(runnerSetupHold.itemId, itemId))
    .returning({ itemId: runnerSetupHold.itemId })
    .get();
  if (deleted === undefined) return false;
  if (hold.runId !== null && now !== undefined)
    orm(db)
      .insert(runnerSetupResume)
      .values({ itemId, runId: hold.runId, releasedAt: now })
      .onConflictDoUpdate({
        target: runnerSetupResume.itemId,
        set: { runId: hold.runId, releasedAt: now },
      })
      .run();
  return true;
}

/**
 * Whether `runId` is the run a released runner-setup hold stopped, so the start continues it
 * instead of opening a new one. Consumes the record either way.
 */
export function takeRunnerSetupResume(db: Database, itemId: string, runId: string): boolean {
  const row = orm(db)
    .delete(runnerSetupResume)
    .where(eq(runnerSetupResume.itemId, itemId))
    .returning({ runId: runnerSetupResume.runId })
    .get();
  return row?.runId === runId;
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
