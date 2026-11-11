import { asc, desc, eq, sql } from "drizzle-orm";
import { type Q, type Steps, type Db } from "./db";
import { jsonText, jsonValue } from "./json-text";

/**
 * A fresh Closeout retry budget for one rebased head. Evidence recorded before
 * `startedAt` is in `retryBaseline` and no longer counts against the budget.
 */
export type CloseoutRound = {
  itemId: string;
  head: string;
  retryBaseline: string[];
  startedAt: number;
};

/** Records the round once per head. Returns false when the head already has one. */
export async function startCloseoutRound(store: Db, input: CloseoutRound): Promise<boolean> {
  return store.run((q) => startCloseoutRoundSteps(q, input));
}

export function* startCloseoutRoundSteps(q: Q, input: CloseoutRound): Steps<boolean> {
  const { closeoutRound } = q.t;
  const inserted = yield* q.all(
    q.orm
      .insert(closeoutRound)
      .values({
        itemId: input.itemId,
        head: input.head,
        retryBaseline: jsonValue(q, input.retryBaseline),
        startedAt: input.startedAt,
      })
      .onConflictDoNothing()
      .returning({ itemId: closeoutRound.itemId }),
  );
  return inserted.length > 0;
}

/** Rounds after the first, oldest first. */
export async function listCloseoutRounds(store: Db, itemId?: string): Promise<CloseoutRound[]> {
  return store.run((q) => listCloseoutRoundsSteps(q, itemId));
}

export function* listCloseoutRoundsSteps(q: Q, itemId?: string): Steps<CloseoutRound[]> {
  const { closeoutRound } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        itemId: closeoutRound.itemId,
        head: closeoutRound.head,
        retryBaseline: jsonText(q, closeoutRound.retryBaseline),
        startedAt: closeoutRound.startedAt,
      })
      .from(closeoutRound)
      .where(itemId === undefined ? undefined : eq(closeoutRound.itemId, itemId))
      .orderBy(
        asc(closeoutRound.startedAt),
        q.dialect === "sqlite" ? sql`rowid` : asc(closeoutRound.head),
      ),
  );
  return rows.map((row) => ({
    ...row,
    retryBaseline: JSON.parse(row.retryBaseline) as string[],
  }));
}

/** Capture evidence only at admission of a human turn, never on redispatch. */
export function* saveHumanRetryWindowSteps(
  q: Q,
  itemId: string,
  jobId: number,
  baseline: readonly string[],
) {
  const { closeoutRetryWindow: window, job } = q.t;
  yield* q.exec(
    q.orm
      .insert(window)
      .values({
        jobId,
        activationId: sql`(SELECT ${job.activationId} FROM ${job} WHERE ${job.id} = ${jobId})`,
        itemId,
        retryBaseline: jsonValue(q, baseline),
      })
      .onConflictDoNothing(),
  );
}

export async function saveHumanRetryWindow(
  store: Db,
  itemId: string,
  jobId: number,
  baseline: readonly string[],
): Promise<void> {
  await store.run((q) => saveHumanRetryWindowSteps(q, itemId, jobId, baseline));
}

export function* humanRetryBaselineSteps(q: Q, itemId: string) {
  const { closeoutRetryWindow: window } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ baseline: jsonText(q, window.retryBaseline) })
      .from(window)
      .where(eq(window.itemId, itemId))
      .orderBy(desc(window.activationId))
      .limit(1),
  );
  return row ? (JSON.parse(row.baseline) as string[]) : [];
}

export async function humanRetryBaseline(store: Db, itemId: string): Promise<string[]> {
  return store.run((q) => humanRetryBaselineSteps(q, itemId));
}
