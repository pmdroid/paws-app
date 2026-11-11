import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { CiRoundCheck } from "./ci-rounds";
import { type Q, type Steps, type Db } from "./db";
import { jsonValue, parsedJson } from "./json-text";
import { emitJobReady } from "./jobs";
import { gatherPullFeedbackSteps, type PullFeedbackWait } from "./pull-comments";

export type PullCiOutcome = "restarted" | "asked" | "dropped" | "cleared";

export type PullCiFailedCheck = {
  name: string;
  url: string | null;
  logTail?: string | null;
  failsOnBase?: boolean;
};

export type PullCiFailureRecord = {
  itemId: string;
  head: string;
  pullNumber: number;
  itemVersion: number;
  failedChecks: PullCiFailedCheck[];
  checks: CiRoundCheck[];
  observedAt: number;
  handledAt: number | null;
  outcome: PullCiOutcome | null;
};

type Row = Q["t"]["pullCiFailure"]["$inferSelect"];

export type PullCiObservation = "recorded" | "known";

const TERMINAL = new Set<PullCiOutcome>(["restarted", "asked"]);

/** `enqueued`: this call added the job that gathers the item's feedback. */
export function* recordPullCiFailureSteps(
  q: Q,
  failure: Omit<PullCiFailureRecord, "handledAt" | "outcome">,
  wait: PullFeedbackWait,
) {
  const { pullCiFailure } = q.t;
  yield* settleOtherHeadsSteps(q, failure.itemId, failure.head, failure.observedAt);
  const existing = yield* selectFailureSteps(q, failure.itemId, failure.head);
  const values = {
    pullNumber: failure.pullNumber,
    itemVersion: failure.itemVersion,
    failedChecks: jsonValue(q, failure.failedChecks),
    checks: jsonValue(q, failure.checks),
  };
  if (
    existing !== undefined &&
    (existing.handledAt === null || TERMINAL.has(existing.outcome as PullCiOutcome))
  ) {
    if (existing.handledAt === null)
      yield* q.exec(
        q.orm
          .update(pullCiFailure)
          .set(values)
          .where(
            and(eq(pullCiFailure.itemId, failure.itemId), eq(pullCiFailure.head, failure.head)),
          ),
      );
    return { observation: "known" as PullCiObservation, enqueued: false };
  }
  yield* q.exec(
    q.orm
      .insert(pullCiFailure)
      .values({
        ...values,
        itemId: failure.itemId,
        head: failure.head,
        observedAt: failure.observedAt,
      })
      .onConflictDoUpdate({
        target: [pullCiFailure.itemId, pullCiFailure.head],
        set: {
          pullNumber: sql`excluded.pull_number`,
          itemVersion: sql`excluded.item_version`,
          failedChecks: sql`excluded.failed_checks`,
          checks: sql`excluded.checks`,
          observedAt: sql`excluded.observed_at`,
          handledAt: null,
          outcome: null,
        },
      }),
  );
  const enqueued = yield* gatherPullFeedbackSteps(
    q,
    failure.itemId,
    failure.observedAt,
    wait,
    `pull-comments:${failure.itemId}:ci:${failure.head}:${failure.observedAt}`,
  );
  return { observation: "recorded" as PullCiObservation, enqueued };
}

export async function recordPullCiFailure(
  store: Db,
  failure: Omit<PullCiFailureRecord, "handledAt" | "outcome">,
  wait: PullFeedbackWait,
): Promise<PullCiObservation> {
  const { observation, enqueued } = await store.run((q) =>
    recordPullCiFailureSteps(q, failure, wait),
  );
  if (enqueued) emitJobReady(store);
  return observation;
}

export function* clearPullCiFailuresSteps(q: Q, itemId: string, head: string, now: number) {
  const { pullCiFailure } = q.t;
  yield* settleOtherHeadsSteps(q, itemId, head, now);
  yield* q.exec(
    q.orm
      .update(pullCiFailure)
      .set({ handledAt: now, outcome: "cleared" })
      .where(
        and(
          eq(pullCiFailure.itemId, itemId),
          eq(pullCiFailure.head, head),
          isNull(pullCiFailure.handledAt),
        ),
      ),
  );
}

export async function clearPullCiFailures(
  store: Db,
  itemId: string,
  head: string,
  now: number,
): Promise<void> {
  await store.run((q) => clearPullCiFailuresSteps(q, itemId, head, now));
}

export function* pendingPullCiFailuresSteps(q: Q, itemId: string) {
  const { pullCiFailure } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(pullCiFailure)
      .where(and(eq(pullCiFailure.itemId, itemId), isNull(pullCiFailure.handledAt)))
      .orderBy(asc(pullCiFailure.observedAt), asc(pullCiFailure.head)),
  );
  return rows.map((row) => mapRow(q, row));
}

export async function pendingPullCiFailures(
  store: Db,
  itemId: string,
): Promise<PullCiFailureRecord[]> {
  return store.run((q) => pendingPullCiFailuresSteps(q, itemId));
}

export function* getPullCiFailureSteps(q: Q, itemId: string, head: string) {
  const row = yield* selectFailureSteps(q, itemId, head);
  return row === undefined ? null : mapRow(q, row);
}

export async function getPullCiFailure(
  store: Db,
  itemId: string,
  head: string,
): Promise<PullCiFailureRecord | null> {
  return store.run((q) => getPullCiFailureSteps(q, itemId, head));
}

export function* settlePullCiFailuresSteps(
  q: Q,
  failures: readonly Pick<PullCiFailureRecord, "itemId" | "head">[],
  outcome: PullCiOutcome,
  now: number,
) {
  const { pullCiFailure } = q.t;
  let settledCount = 0;
  for (const failure of failures)
    settledCount += (yield* q.all(
      q.orm
        .update(pullCiFailure)
        .set({ handledAt: now, outcome })
        .where(
          and(
            eq(pullCiFailure.itemId, failure.itemId),
            eq(pullCiFailure.head, failure.head),
            isNull(pullCiFailure.handledAt),
          ),
        )
        .returning({ itemId: pullCiFailure.itemId }),
    )).length;
  return settledCount;
}

export async function settlePullCiFailures(
  store: Db,
  failures: readonly Pick<PullCiFailureRecord, "itemId" | "head">[],
  outcome: PullCiOutcome,
  now: number,
): Promise<number> {
  return store.run((q) => settlePullCiFailuresSteps(q, failures, outcome, now));
}

function* settleOtherHeadsSteps(q: Q, itemId: string, head: string, now: number) {
  const { pullCiFailure } = q.t;
  yield* q.exec(
    q.orm
      .update(pullCiFailure)
      .set({ handledAt: now, outcome: "dropped" })
      .where(
        and(
          eq(pullCiFailure.itemId, itemId),
          ne(pullCiFailure.head, head),
          isNull(pullCiFailure.handledAt),
        ),
      ),
  );
}

function* selectFailureSteps(q: Q, itemId: string, head: string) {
  const { pullCiFailure } = q.t;
  return yield* q.one(
    q.orm
      .select()
      .from(pullCiFailure)
      .where(and(eq(pullCiFailure.itemId, itemId), eq(pullCiFailure.head, head))),
  );
}

function mapRow(q: Q, row: Row): PullCiFailureRecord {
  return {
    itemId: row.itemId,
    head: row.head,
    pullNumber: row.pullNumber,
    itemVersion: row.itemVersion,
    failedChecks: parsedJson<PullCiFailedCheck[]>(q, row.failedChecks),
    checks: parsedJson<CiRoundCheck[]>(q, row.checks),
    observedAt: row.observedAt,
    handledAt: row.handledAt,
    outcome: row.outcome as PullCiOutcome | null,
  };
}

/** Keep the lane timer in the existing failure row without scheduling review feedback. */
export function* laneCiFailureTimeSteps(
  q: Q,
  failure: Omit<PullCiFailureRecord, "handledAt" | "outcome">,
): Steps<number> {
  const t = q.t.pullCiFailure;
  const row = yield* selectFailureSteps(q, failure.itemId, failure.head);
  const first = row?.laneFirstFailureAt ?? failure.observedAt;
  yield* q.exec(
    q.orm
      .insert(t)
      .values({
        ...failure,
        failedChecks: jsonValue(q, failure.failedChecks),
        checks: jsonValue(q, failure.checks),
        laneFirstFailureAt: first,
        handledAt: failure.observedAt,
        outcome: "cleared",
      })
      .onConflictDoUpdate({
        target: [t.itemId, t.head],
        set: { laneFirstFailureAt: first },
      }),
  );
  return first;
}

export async function laneCiFailureTime(
  store: Db,
  failure: Omit<PullCiFailureRecord, "handledAt" | "outcome">,
): Promise<number> {
  return store.run((q) => laneCiFailureTimeSteps(q, failure));
}

/** Observing another head invalidates the old collection window. */
export function* resetOtherLaneCiFailuresSteps(q: Q, itemId: string, head: string) {
  const t = q.t.pullCiFailure;
  yield* q.exec(
    q.orm
      .update(t)
      .set({ laneFirstFailureAt: null })
      .where(and(eq(t.itemId, itemId), ne(t.head, head))),
  );
}

export async function resetOtherLaneCiFailures(
  store: Db,
  itemId: string,
  head: string,
): Promise<void> {
  await store.run((q) => resetOtherLaneCiFailuresSteps(q, itemId, head));
}
