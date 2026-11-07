import type { Database } from "bun:sqlite";
import { and, asc, eq, gt, isNull, notExists, notInArray, sql } from "drizzle-orm";
import { readCheckpoint } from "./checkpoint";
import { randomUUID } from "node:crypto";
import type { Checkpoint, RunKind, RunStatus, GitCommitPolicy } from "../core";
import { orm } from "./orm";
import {
  run as runTable,
  runOwner as runOwnerTable,
  runReviewRounds,
  runnerWork,
  runnerWorkGrant,
  workItem,
} from "./schema";

export type StoredRun = {
  id: string;
  itemId: string;
  kind: RunKind;
  agent: string;
  status: RunStatus;
  checkpoint: Checkpoint | null;
  freshSession: boolean;
  createdAt: number;
  updatedAt: number;
};

type RunSql = typeof runTable.$inferSelect;

export function insertRun(
  db: Database,
  input: {
    itemId: string;
    now: number;
    kind?: RunKind;
    agent?: string;
    status?: RunStatus;
    checkpoint?: Checkpoint | null;
    freshSession?: boolean;
    ownerInstance?: string | null;
  },
): StoredRun {
  const id = randomUUID();
  const checkpoint = input.checkpoint ?? null;
  orm(db)
    .insert(runTable)
    .values({
      id,
      itemId: input.itemId,
      kind: input.kind ?? "implement",
      agent: input.agent ?? "cursor",
      status: input.status ?? "active",
      checkpoint: checkpoint === null ? null : JSON.stringify(checkpoint),
      freshSession: input.freshSession === true ? 1 : 0,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .run();
  if (input.ownerInstance != null) claimRun(db, id, input.ownerInstance);
  const run = getRun(db, id);
  if (run === null) throw new Error("insertRun did not store a row");
  return run;
}

export function getRun(db: Database, id: string): StoredRun | null {
  const row = orm(db).select().from(runTable).where(eq(runTable.id, id)).get();
  return row === undefined ? null : mapRun(row);
}

/** Every run, oldest first. Pass `itemId` to keep one work item. */
export function listRuns(db: Database, itemId?: string): StoredRun[] {
  return orm(db)
    .select()
    .from(runTable)
    .where(itemId === undefined ? undefined : eq(runTable.itemId, itemId))
    .orderBy(asc(runTable.createdAt), asc(runTable.id))
    .all()
    .map(mapRun);
}

export function runOwner(db: Database, runId: string): string | null {
  return (
    orm(db)
      .select({ owner: runOwnerTable.ownerInstance })
      .from(runOwnerTable)
      .where(eq(runOwnerTable.runId, runId))
      .get()?.owner ?? null
  );
}

export function claimRun(db: Database, runId: string, ownerInstance: string): void {
  orm(db)
    .insert(runOwnerTable)
    .values({ runId, ownerInstance })
    .onConflictDoUpdate({ target: runOwnerTable.runId, set: { ownerInstance } })
    .run();
}

export function markRun(db: Database, id: string, status: RunStatus, now: number): void {
  orm(db).update(runTable).set({ status, updatedAt: now }).where(eq(runTable.id, id)).run();
}

/** How many review rounds the item needed by the time this run verified it. */
export function recordReviewRounds(db: Database, id: string, rounds: number): void {
  orm(db)
    .insert(runReviewRounds)
    .values({ runId: id, rounds })
    .onConflictDoUpdate({ target: runReviewRounds.runId, set: { rounds } })
    .run();
}

/** The review rounds recorded on the run, or null when it never verified a review. */
export function reviewRoundsOf(db: Database, id: string): number | null {
  return (
    orm(db)
      .select({ rounds: runReviewRounds.rounds })
      .from(runReviewRounds)
      .where(eq(runReviewRounds.runId, id))
      .get()?.rounds ?? null
  );
}

export function releaseRunCapacity(db: Database, runId: string, now: number): void {
  const run = getRun(db, runId);
  if (run && (run.status === "active" || run.status === "provisioning"))
    markRun(db, runId, "ended", now);
  orm(db)
    .update(runnerWork)
    .set({ endedAt: now })
    .where(and(eq(runnerWork.runId, runId), isNull(runnerWork.endedAt)))
    .run();
  orm(db).delete(runnerWorkGrant).where(eq(runnerWorkGrant.runId, runId)).run();
}

export function saveRunResult(db: Database, id: string, resultBody: string, now: number): void {
  const run = getRun(db, id);
  if (run === null) throw new Error(`run ${id} not found`);
  const checkpoint = { ...(run.checkpoint ?? { phase: "running" }), resultBody };
  orm(db)
    .update(runTable)
    .set({ checkpoint: JSON.stringify(checkpoint), updatedAt: now })
    .where(eq(runTable.id, id))
    .run();
}

function mapRun(row: RunSql): StoredRun {
  return {
    id: row.id,
    itemId: row.itemId,
    kind: row.kind as RunKind,
    agent: row.agent,
    status: row.status as RunStatus,
    checkpoint: row.checkpoint === null ? null : readCheckpoint(row.checkpoint),
    freshSession: row.freshSession === 1,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function saveRunCommitPolicy(db: Database, id: string, policy: GitCommitPolicy): void {
  const run = getRun(db, id);
  if (!run) throw new Error("Attribution run is missing");
  if (
    run.checkpoint?.commitPolicy &&
    JSON.stringify(run.checkpoint.commitPolicy) !== JSON.stringify(policy)
  )
    throw new Error("Run attribution snapshot cannot change");
  saveCheckpoint(db, id, { ...(run.checkpoint ?? { phase: "running" }), commitPolicy: policy });
}

function saveCheckpoint(db: Database, id: string, checkpoint: Checkpoint): void {
  orm(db)
    .update(runTable)
    .set({ checkpoint: JSON.stringify(checkpoint) })
    .where(eq(runTable.id, id))
    .run();
}

/**
 * The run's checkout exclusions. The first call stores `resolve()` on the run; every later call
 * returns that, so a settings change never alters a checkout a run already started with.
 */
export function pinRunCheckout(
  db: Database,
  id: string,
  resolve: () => NonNullable<Checkpoint["checkout"]>,
): NonNullable<Checkpoint["checkout"]> {
  const run = getRun(db, id);
  if (!run) return resolve();
  if (run.checkpoint?.checkout) return run.checkpoint.checkout;
  const checkout = resolve();
  saveCheckpoint(db, id, { ...(run.checkpoint ?? { phase: "running" }), checkout });
  return checkout;
}

export function getItemRunCommitPolicy(db: Database, itemId: string): GitCommitPolicy | undefined {
  return listRuns(db, itemId)
    .toReversed()
    .find((run) => run.checkpoint?.commitPolicy)?.checkpoint?.commitPolicy;
}

/** Existing runs eligible for a Settings profile update. A live work lease owns its snapshot. */
export function listWaitingProfileRuns(db: Database, now: number): StoredRun[] {
  return orm(db)
    .select({ run: runTable })
    .from(runTable)
    .innerJoin(workItem, eq(workItem.id, runTable.itemId))
    .where(
      and(
        notInArray(workItem.state, ["queued", "completed", "merged", "cancelled"]),
        eq(workItem.cancelRequested, 0),
        notExists(
          orm(db)
            .select({ one: sql`1` })
            .from(runnerWork)
            .where(
              and(
                eq(runnerWork.runId, runTable.id),
                isNull(runnerWork.endedAt),
                gt(runnerWork.leaseUntil, now),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(runTable.createdAt), asc(runTable.id))
    .all()
    .map((row) => mapRun(row.run));
}
