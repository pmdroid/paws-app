import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { CiRoundCheck } from "./ci-rounds";
import { orm } from "./orm";
import { gatherPullFeedback, type PullFeedbackWait } from "./pull-comments";
import { pullCiFailure } from "./schema";

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

type Row = typeof pullCiFailure.$inferSelect;

export type PullCiObservation = "recorded" | "known";

const TERMINAL = new Set<PullCiOutcome>(["restarted", "asked"]);

export function recordPullCiFailure(
  db: Database,
  failure: Omit<PullCiFailureRecord, "handledAt" | "outcome">,
  wait: PullFeedbackWait,
): PullCiObservation {
  settleOtherHeads(db, failure.itemId, failure.head, failure.observedAt);
  const existing = selectFailure(db, failure.itemId, failure.head);
  const values = {
    pullNumber: failure.pullNumber,
    itemVersion: failure.itemVersion,
    failedChecks: JSON.stringify(failure.failedChecks),
    checks: JSON.stringify(failure.checks),
  };
  if (
    existing !== undefined &&
    (existing.handledAt === null || TERMINAL.has(existing.outcome as PullCiOutcome))
  ) {
    if (existing.handledAt === null)
      orm(db)
        .update(pullCiFailure)
        .set(values)
        .where(and(eq(pullCiFailure.itemId, failure.itemId), eq(pullCiFailure.head, failure.head)))
        .run();
    return "known";
  }
  orm(db)
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
    })
    .run();
  gatherPullFeedback(
    db,
    failure.itemId,
    failure.observedAt,
    wait,
    `pull-comments:${failure.itemId}:ci:${failure.head}:${failure.observedAt}`,
  );
  return "recorded";
}

export function clearPullCiFailures(db: Database, itemId: string, head: string, now: number): void {
  settleOtherHeads(db, itemId, head, now);
  orm(db)
    .update(pullCiFailure)
    .set({ handledAt: now, outcome: "cleared" })
    .where(
      and(
        eq(pullCiFailure.itemId, itemId),
        eq(pullCiFailure.head, head),
        isNull(pullCiFailure.handledAt),
      ),
    )
    .run();
}

export function pendingPullCiFailures(db: Database, itemId: string): PullCiFailureRecord[] {
  return orm(db)
    .select()
    .from(pullCiFailure)
    .where(and(eq(pullCiFailure.itemId, itemId), isNull(pullCiFailure.handledAt)))
    .orderBy(asc(pullCiFailure.observedAt), asc(pullCiFailure.head))
    .all()
    .map(mapRow);
}

export function getPullCiFailure(
  db: Database,
  itemId: string,
  head: string,
): PullCiFailureRecord | null {
  const row = selectFailure(db, itemId, head);
  return row === undefined ? null : mapRow(row);
}

export function settlePullCiFailures(
  db: Database,
  failures: readonly Pick<PullCiFailureRecord, "itemId" | "head">[],
  outcome: PullCiOutcome,
  now: number,
): number {
  let settled = 0;
  for (const failure of failures)
    settled += orm(db)
      .update(pullCiFailure)
      .set({ handledAt: now, outcome })
      .where(
        and(
          eq(pullCiFailure.itemId, failure.itemId),
          eq(pullCiFailure.head, failure.head),
          isNull(pullCiFailure.handledAt),
        ),
      )
      .returning({ itemId: pullCiFailure.itemId })
      .all().length;
  return settled;
}

function settleOtherHeads(db: Database, itemId: string, head: string, now: number): void {
  orm(db)
    .update(pullCiFailure)
    .set({ handledAt: now, outcome: "dropped" })
    .where(
      and(
        eq(pullCiFailure.itemId, itemId),
        ne(pullCiFailure.head, head),
        isNull(pullCiFailure.handledAt),
      ),
    )
    .run();
}

function selectFailure(db: Database, itemId: string, head: string): Row | undefined {
  return orm(db)
    .select()
    .from(pullCiFailure)
    .where(and(eq(pullCiFailure.itemId, itemId), eq(pullCiFailure.head, head)))
    .get();
}

function mapRow(row: Row): PullCiFailureRecord {
  return {
    itemId: row.itemId,
    head: row.head,
    pullNumber: row.pullNumber,
    itemVersion: row.itemVersion,
    failedChecks: JSON.parse(row.failedChecks) as PullCiFailedCheck[],
    checks: JSON.parse(row.checks) as CiRoundCheck[],
    observedAt: row.observedAt,
    handledAt: row.handledAt,
    outcome: row.outcome as PullCiOutcome | null,
  };
}
