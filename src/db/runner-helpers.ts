import type { Database } from "bun:sqlite";
import { and, asc, eq, gt, isNull, sql, type SQL } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps, type Db } from "./db";
import { jsonFromText, jsonText } from "./json-text";

export type RunnerHelperRow = {
  runnerId: string;
  workspaceId: string;
  runnerFence: number;
  envelope: string;
  endedAt: number | null;
  result: string | null;
};

export function* runnerHelperRowSteps(q: Q, id: string): Steps<RunnerHelperRow | null> {
  const { runnerHelper: helper } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        runnerId: helper.runnerId,
        workspaceId: helper.workspaceId,
        runnerFence: helper.runnerFence,
        envelope: jsonText(q, helper.envelope),
        endedAt: helper.endedAt,
        result: jsonText(q, helper.result) as SQL<string | null>,
      })
      .from(helper)
      .where(eq(helper.id, id)),
  );
  return row ?? null;
}

export function runnerHelperRow(db: Database, id: string): RunnerHelperRow | null {
  return settled(sqliteDb(db).run((q) => runnerHelperRowSteps(q, id)));
}

type NewRunnerHelper = {
  id: string;
  runnerId: string;
  workspaceId: string;
  sessionId: string;
  sessionGeneration: number;
  runnerFence: number;
  envelope: string;
  expiresAt: number;
  purpose: string;
};

export function* insertRunnerHelperSteps(q: Q, row: NewRunnerHelper) {
  yield* q.exec(
    q.orm.insert(q.t.runnerHelper).values({ ...row, envelope: jsonFromText(q, row.envelope) }),
  );
}

export function insertRunnerHelper(db: Database, row: NewRunnerHelper): void {
  settled(sqliteDb(db).run((q) => insertRunnerHelperSteps(q, row)));
}

/** Helpers the runner has not acknowledged, oldest first on SQLite and by id on Postgres. */
export function* unacknowledgedRunnerHelpersSteps(
  q: Q,
  runnerId: string,
  at: number,
): Steps<string[]> {
  const { runnerHelper: helper } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ id: helper.id })
      .from(helper)
      .where(
        and(
          eq(helper.runnerId, runnerId),
          isNull(helper.acknowledgedAt),
          isNull(helper.endedAt),
          gt(helper.expiresAt, at),
        ),
      )
      .orderBy(q.dialect === "sqlite" ? sql`rowid` : asc(helper.id)),
  );
  return rows.map((row) => row.id);
}

export async function unacknowledgedRunnerHelpers(
  store: Db,
  runnerId: string,
  at: number,
): Promise<string[]> {
  return store.run((q) => unacknowledgedRunnerHelpersSteps(q, runnerId, at));
}

export function* acknowledgeRunnerHelperSteps(q: Q, id: string, at: number) {
  const { runnerHelper: helper } = q.t;
  yield* q.exec(
    q.orm
      .update(helper)
      .set({ acknowledgedAt: sql`COALESCE(${helper.acknowledgedAt}, ${at})` })
      .where(eq(helper.id, id)),
  );
}

export async function acknowledgeRunnerHelper(store: Db, id: string, at: number): Promise<void> {
  await store.run((q) => acknowledgeRunnerHelperSteps(q, id, at));
}

/** Whether the stored result is this payload: JSON equality on Postgres, text on SQLite. */
export function* runnerHelperResultMatchesSteps(q: Q, id: string, payload: string): Steps<boolean> {
  const { runnerHelper: helper } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: helper.id })
      .from(helper)
      .where(and(eq(helper.id, id), eq(helper.result, jsonFromText(q, payload)))),
  );
  return row !== undefined;
}

export async function runnerHelperResultMatches(
  store: Db,
  id: string,
  payload: string,
): Promise<boolean> {
  return store.run((q) => runnerHelperResultMatchesSteps(q, id, payload));
}

export function* storeRunnerHelperResultSteps(q: Q, id: string, payload: string) {
  const { runnerHelper: helper } = q.t;
  yield* q.exec(
    q.orm
      .update(helper)
      .set({ result: jsonFromText(q, payload) })
      .where(eq(helper.id, id)),
  );
}

export async function storeRunnerHelperResult(
  store: Db,
  id: string,
  payload: string,
): Promise<void> {
  await store.run((q) => storeRunnerHelperResultSteps(q, id, payload));
}

export function* endRunnerHelperSteps(q: Q, id: string, at: number) {
  const { runnerHelper: helper } = q.t;
  yield* q.exec(
    q.orm
      .update(helper)
      .set({ endedAt: sql`COALESCE(${helper.endedAt}, ${at})` })
      .where(eq(helper.id, id)),
  );
}

export function endRunnerHelper(db: Database, id: string, at: number): void {
  settled(sqliteDb(db).run((q) => endRunnerHelperSteps(q, id, at)));
}
