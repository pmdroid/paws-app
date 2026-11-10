import type { Database } from "bun:sqlite";
import { asc, desc, eq, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";
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

type RoundRow = {
  item_id: string;
  head: string;
  retry_baseline: string;
  started_at: number;
};

/** Records the round once per head. Returns false when the head already has one. */
export function startCloseoutRound(db: Database, input: CloseoutRound): boolean {
  return (
    db.run(
      `INSERT OR IGNORE INTO closeout_round (item_id, head, retry_baseline, started_at) VALUES (?, ?, ?, ?)`,
      [input.itemId, input.head, JSON.stringify(input.retryBaseline), input.startedAt],
    ).changes > 0
  );
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
export function listCloseoutRounds(db: Database, itemId?: string): CloseoutRound[] {
  const rows =
    itemId === undefined
      ? db.query<RoundRow, []>(`SELECT * FROM closeout_round ORDER BY started_at, rowid`).all()
      : db
          .query<RoundRow, [string]>(
            `SELECT * FROM closeout_round WHERE item_id = ? ORDER BY started_at, rowid`,
          )
          .all(itemId);
  return rows.map((row) => ({
    itemId: row.item_id,
    head: row.head,
    retryBaseline: JSON.parse(row.retry_baseline) as string[],
    startedAt: row.started_at,
  }));
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

export function saveHumanRetryWindow(
  db: Database,
  itemId: string,
  jobId: number,
  baseline: readonly string[],
): void {
  settled(sqliteDb(db).run((q) => saveHumanRetryWindowSteps(q, itemId, jobId, baseline)));
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

export function humanRetryBaseline(db: Database, itemId: string): string[] {
  const row = db
    .query<{ baseline: string }, [string]>(
      "SELECT retry_baseline AS baseline FROM closeout_retry_window WHERE item_id=? ORDER BY activation_id DESC LIMIT 1",
    )
    .get(itemId);
  return row ? (JSON.parse(row.baseline) as string[]) : [];
}
