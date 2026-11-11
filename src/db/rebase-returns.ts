import type { Database } from "bun:sqlite";
import { and, count, eq, gte, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps, type Db } from "./db";
import { jsonText, jsonValue } from "./json-text";

export type RebaseReturn = {
  itemId: string;
  jobId: number;
  candidate: string | null;
  reason: "merge" | "github_queue" | "linear" | "push";
  /** The main commit the branch conflicted with, when known. */
  base?: string | null;
  /** The files that conflicted, when the rebase was attempted. */
  files?: readonly string[] | null;
  recordedAt?: number | null;
};

/** A recorded return, oldest first, as the rebase budget reads it. */
export type RebaseReturnRecord = {
  jobId: number;
  reason: RebaseReturn["reason"];
  base: string | null;
  files: string[] | null;
  recordedAt: number | null;
};

export function* recordRebaseReturnSteps(q: Q, row: RebaseReturn) {
  const { job, rebaseReturn } = q.t;
  const activation = q.orm.select({ id: job.activationId }).from(job).where(eq(job.id, row.jobId));
  yield* q.exec(
    q.orm
      .insert(rebaseReturn)
      .values({
        jobId: row.jobId,
        activationId: sql`COALESCE((${activation}), ${row.jobId})`,
        itemId: row.itemId,
        candidate: row.candidate,
        reason: row.reason,
        base: row.base ?? null,
        files: row.files == null ? null : jsonValue(q, row.files),
        recordedAt: row.recordedAt ?? null,
      })
      .onConflictDoNothing({ target: [rebaseReturn.jobId, rebaseReturn.activationId] }),
  );
}

export function recordRebaseReturn(db: Database, row: RebaseReturn): void {
  settled(sqliteDb(db).run((q) => recordRebaseReturnSteps(q, row)));
}

export function* countRebaseReturnsSteps(q: Q, itemId: string, sinceActivationId: number) {
  const { rebaseReturn } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ n: count() })
      .from(rebaseReturn)
      .where(
        and(eq(rebaseReturn.itemId, itemId), gte(rebaseReturn.activationId, sinceActivationId)),
      ),
  );
  return Number(row?.n ?? 0);
}

export function countRebaseReturns(
  db: Database,
  itemId: string,
  sinceActivationId: number,
): number {
  return settled(sqliteDb(db).run((q) => countRebaseReturnsSteps(q, itemId, sinceActivationId)));
}

export function* listRebaseReturnsSteps(
  q: Q,
  itemId: string,
  sinceActivationId: number,
): Steps<RebaseReturnRecord[]> {
  const { rebaseReturn } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        jobId: rebaseReturn.jobId,
        reason: rebaseReturn.reason,
        base: rebaseReturn.base,
        files: jsonText(q, rebaseReturn.files),
        recordedAt: rebaseReturn.recordedAt,
      })
      .from(rebaseReturn)
      .where(
        and(eq(rebaseReturn.itemId, itemId), gte(rebaseReturn.activationId, sinceActivationId)),
      )
      .orderBy(rebaseReturn.activationId),
  );
  return rows.map((row) => ({
    ...row,
    reason: row.reason as RebaseReturn["reason"],
    files: row.files === null ? null : (JSON.parse(row.files) as string[]),
  }));
}

export function listRebaseReturns(
  db: Database,
  itemId: string,
  sinceActivationId: number,
): RebaseReturnRecord[] {
  return settled(sqliteDb(db).run((q) => listRebaseReturnsSteps(q, itemId, sinceActivationId)));
}

export function* rebaseReturnedForSteps(q: Q, itemId: string, candidate: string) {
  const { rebaseReturn } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(rebaseReturn)
      .where(and(eq(rebaseReturn.itemId, itemId), eq(rebaseReturn.candidate, candidate)))
      .limit(1),
  );
  return row !== undefined;
}

/** Whether the item already went back to the agent for a rebase of `candidate`. */
export async function rebaseReturnedFor(
  store: Db,
  itemId: string,
  candidate: string,
): Promise<boolean> {
  return store.run((q) => rebaseReturnedForSteps(q, itemId, candidate));
}
