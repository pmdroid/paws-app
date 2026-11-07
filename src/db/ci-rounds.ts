import type { Database } from "bun:sqlite";
import { and, asc, eq, gte, max, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import { jsonValue, parsedJson } from "./json-text";

export type CiRoundCheck = {
  name: string;
  state: "passed" | "failed" | "running" | "skipped";
  url: string | null;
  startedAt: string | null;
  completedAt: string | null;
  logTail: string | null;
  logSource: "actions" | "summary" | null;
};

/**
 * One failed CI read of a pull request head: every check on it, and what Paws did next.
 * `agent` sent it back for fix `fix` of `fixLimit`; `asked` asked in Linear because the
 * fixes were spent; `failed` stopped the task.
 */
export type CiRound = {
  itemId: string;
  head: string;
  runId: string | null;
  next: "agent" | "asked" | "failed";
  fix: number | null;
  fixLimit: number;
  checks: CiRoundCheck[];
  recordedAt: number;
};

/** One round per head. A head read again replaces its checks and outcome. */
export function* recordCiRoundSteps(q: Q, round: CiRound) {
  const { ciRound } = q.t;
  yield* q.exec(
    q.orm
      .insert(ciRound)
      .values({
        itemId: round.itemId,
        head: round.head,
        runId: round.runId,
        next: round.next,
        fix: round.fix,
        fixLimit: round.fixLimit,
        checks: jsonValue(q, round.checks),
        recordedAt: round.recordedAt,
      })
      .onConflictDoUpdate({
        target: [ciRound.itemId, ciRound.head],
        set: {
          runId: sql`excluded.run_id`,
          next: sql`excluded.next`,
          fix: sql`excluded.fix`,
          fixLimit: sql`excluded.fix_limit`,
          checks: sql`excluded.checks`,
          recordedAt: sql`excluded.recorded_at`,
        },
      }),
  );
}

export function recordCiRound(db: Database, round: CiRound): void {
  settled(sqliteDb(db).run((q) => recordCiRoundSteps(q, round)));
}

/** Oldest first. */
export function* listCiRoundsSteps(q: Q, itemId?: string) {
  const { ciRound } = q.t;
  const rows = yield* q.all(
    q.orm
      .select()
      .from(ciRound)
      .where(itemId === undefined ? undefined : eq(ciRound.itemId, itemId))
      .orderBy(
        asc(ciRound.recordedAt),
        ...(q.dialect === "sqlite" ? [sql`rowid`] : [asc(ciRound.itemId), asc(ciRound.head)]),
      ),
  );
  return rows.map((row): CiRound => ({
    itemId: row.itemId,
    head: row.head,
    runId: row.runId,
    next: row.next as CiRound["next"],
    fix: row.fix,
    fixLimit: row.fixLimit,
    checks: parsedJson<CiRoundCheck[]>(q, row.checks),
    recordedAt: row.recordedAt,
  }));
}

export function listCiRounds(db: Database, itemId?: string): CiRound[] {
  return settled(sqliteDb(db).run((q) => listCiRoundsSteps(q, itemId)));
}

export function* countCiFixesSteps(q: Q, itemId: string, sinceJobId: number) {
  const { ciRound, job } = q.t;
  const since = q.orm.select({ createdAt: job.createdAt }).from(job).where(eq(job.id, sinceJobId));
  const row = yield* q.one(
    q.orm
      .select({ n: max(ciRound.fix) })
      .from(ciRound)
      .where(
        and(
          eq(ciRound.itemId, itemId),
          eq(ciRound.next, "agent"),
          gte(ciRound.recordedAt, sql`COALESCE((${since}), 0)`),
        ),
      ),
  );
  return Number(row?.n ?? 0);
}

export function countCiFixes(db: Database, itemId: string, sinceJobId: number): number {
  return settled(sqliteDb(db).run((q) => countCiFixesSteps(q, itemId, sinceJobId)));
}
