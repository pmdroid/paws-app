import type { Database } from "bun:sqlite";
import { and, eq, inArray, sql } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { orm } from "./orm";
import { job, mergeCall, remoteMergeFact } from "./schema";
import { immediate } from "./tx";

export type ConfirmedRemoteMerge = {
  itemId: string;
  repositoryOwner: string;
  repositoryName: string;
  pullNumber: number;
  pullUrl: string | null;
  mergeSha: string | null;
  confirmedAt: number;
};

export function getConfirmedRemoteMerge(db: Database, itemId: string): ConfirmedRemoteMerge | null {
  return (
    orm(db)
      .select({
        itemId: remoteMergeFact.itemId,
        repositoryOwner: remoteMergeFact.repositoryOwner,
        repositoryName: remoteMergeFact.repositoryName,
        pullNumber: remoteMergeFact.pullNumber,
        pullUrl: remoteMergeFact.pullUrl,
        mergeSha: remoteMergeFact.mergeSha,
        confirmedAt: remoteMergeFact.confirmedAt,
      })
      .from(remoteMergeFact)
      .where(eq(remoteMergeFact.itemId, itemId))
      .get() ?? null
  );
}

export function recordConfirmedRemoteMerge(
  db: Database,
  input: ConfirmedRemoteMerge,
): ConfirmedRemoteMerge {
  return immediate(db, () => {
    orm(db)
      .insert(remoteMergeFact)
      .values({
        itemId: input.itemId,
        repositoryOwner: input.repositoryOwner,
        repositoryName: input.repositoryName,
        pullNumber: input.pullNumber,
        pullUrl: input.pullUrl,
        mergeSha: input.mergeSha,
        confirmedAt: input.confirmedAt,
      })
      .onConflictDoNothing({ target: remoteMergeFact.itemId })
      .run();
    const saved = getConfirmedRemoteMerge(db, input.itemId);
    if (
      saved === null ||
      saved.repositoryOwner !== input.repositoryOwner ||
      saved.repositoryName !== input.repositoryName ||
      saved.pullNumber !== input.pullNumber ||
      saved.mergeSha !== input.mergeSha
    )
      throw new Error("The confirmed remote merge conflicts with its saved task history.");
    return saved;
  });
}

/**
 * Marks the GitHub merge call for the item's head as in flight, just before the lane makes it.
 * A marker left when Paws stops means the call may have reached GitHub, so the next start asks
 * GitHub before the item merges or re-verifies.
 */
export function beginMergeCall(db: Database, itemId: string, head: string, now: number): void {
  orm(db)
    .insert(mergeCall)
    .values({ itemId, headSha: head, startedAt: now })
    .onConflictDoUpdate({
      target: mergeCall.itemId,
      set: { headSha: sql`excluded.head_sha`, startedAt: sql`excluded.started_at` },
    })
    .run();
}

/** The merge call returned, or its outcome was read from GitHub after a restart. */
export function endMergeCall(db: Database, itemId: string): void {
  orm(db).delete(mergeCall).where(eq(mergeCall.itemId, itemId)).run();
}

export function mergeCallInFlight(db: Database, itemId: string): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(mergeCall)
      .where(eq(mergeCall.itemId, itemId))
      .get() !== undefined
  );
}

/** A durable stop waiting for the lane to settle its call also guards an unsent squash. */
export function mergeStopRequested(db: Database, itemId: string): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(job)
      .where(
        and(
          eq(job.queue, JOB_KIND.command),
          inArray(job.status, ["pending", "running"]),
          sql`json_extract(${job.payload}, '$.itemId') = ${itemId}`,
          sql`json_extract(${job.payload}, '$.type') IN ('stop','cancel')`,
        ),
      )
      .limit(1)
      .get() !== undefined
  );
}
