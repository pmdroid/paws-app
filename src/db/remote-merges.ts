import { and, eq, inArray, sql } from "drizzle-orm";
import { JOB_KIND } from "../core";
import { type Q, type Db } from "./db";
import { jsonField } from "./json-text";

export type ConfirmedRemoteMerge = {
  itemId: string;
  repositoryOwner: string;
  repositoryName: string;
  pullNumber: number;
  pullUrl: string | null;
  mergeSha: string | null;
  confirmedAt: number;
};

export function* getConfirmedRemoteMergeSteps(q: Q, itemId: string) {
  const { remoteMergeFact } = q.t;
  const row = yield* q.one(
    q.orm
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
      .where(eq(remoteMergeFact.itemId, itemId)),
  );
  return row ?? null;
}

export async function getConfirmedRemoteMerge(
  store: Db,
  itemId: string,
): Promise<ConfirmedRemoteMerge | null> {
  return store.run((q) => getConfirmedRemoteMergeSteps(q, itemId));
}

export function* recordConfirmedRemoteMergeSteps(q: Q, input: ConfirmedRemoteMerge) {
  const { remoteMergeFact } = q.t;
  yield* q.exec(
    q.orm
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
      .onConflictDoNothing({ target: remoteMergeFact.itemId }),
  );
  const saved = yield* getConfirmedRemoteMergeSteps(q, input.itemId);
  if (
    saved === null ||
    saved.repositoryOwner !== input.repositoryOwner ||
    saved.repositoryName !== input.repositoryName ||
    saved.pullNumber !== input.pullNumber ||
    saved.mergeSha !== input.mergeSha
  )
    throw new Error("The confirmed remote merge conflicts with its saved task history.");
  return saved;
}

export async function recordConfirmedRemoteMerge(
  store: Db,
  input: ConfirmedRemoteMerge,
): Promise<ConfirmedRemoteMerge> {
  return store.transaction((q) => recordConfirmedRemoteMergeSteps(q, input));
}

export function* beginMergeCallSteps(q: Q, itemId: string, head: string, now: number) {
  const { mergeCall } = q.t;
  yield* q.exec(
    q.orm
      .insert(mergeCall)
      .values({ itemId, headSha: head, startedAt: now })
      .onConflictDoUpdate({
        target: mergeCall.itemId,
        set: { headSha: sql`excluded.head_sha`, startedAt: sql`excluded.started_at` },
      }),
  );
}

/**
 * Marks the GitHub merge call for the item's head as in flight, just before the lane makes it.
 * A marker left when Paws stops means the call may have reached GitHub, so the next start asks
 * GitHub before the item merges or re-verifies.
 */
export async function beginMergeCall(
  store: Db,
  itemId: string,
  head: string,
  now: number,
): Promise<void> {
  await store.run((q) => beginMergeCallSteps(q, itemId, head, now));
}

export function* endMergeCallSteps(q: Q, itemId: string) {
  yield* q.exec(q.orm.delete(q.t.mergeCall).where(eq(q.t.mergeCall.itemId, itemId)));
}

/** The merge call returned, or its outcome was read from GitHub after a restart. */
export async function endMergeCall(store: Db, itemId: string): Promise<void> {
  await store.run((q) => endMergeCallSteps(q, itemId));
}

export function* mergeCallInFlightSteps(q: Q, itemId: string) {
  const { mergeCall } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(mergeCall)
      .where(eq(mergeCall.itemId, itemId)),
  );
  return row !== undefined;
}

export async function mergeCallInFlight(store: Db, itemId: string): Promise<boolean> {
  return store.run((q) => mergeCallInFlightSteps(q, itemId));
}

export function* mergeStopRequestedSteps(q: Q, itemId: string) {
  const { job } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(job)
      .where(
        and(
          eq(job.queue, JOB_KIND.command),
          inArray(job.status, ["pending", "running"]),
          eq(jsonField(q, job.payload, "itemId"), itemId),
          inArray(jsonField(q, job.payload, "type"), ["stop", "cancel"]),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

/** A durable stop waiting for the lane to settle its call also guards an unsent squash. */
export async function mergeStopRequested(store: Db, itemId: string): Promise<boolean> {
  return store.run((q) => mergeStopRequestedSteps(q, itemId));
}
