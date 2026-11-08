import type { Database } from "bun:sqlite";
import { and, count, desc, eq, gt, inArray, isNull, notExists } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import { jsonText } from "./json-text";

const HEALTH_KINDS = ["probe", "login_check"];

export function* runnerHealthCommandEnvelopeSteps(q: Q, commandId: string, runnerId: string) {
  const { runnerCommand: c } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ envelope: jsonText(q, c.envelope) })
      .from(c)
      .where(and(eq(c.id, commandId), eq(c.runnerId, runnerId), inArray(c.kind, HEALTH_KINDS))),
  );
  return row?.envelope ?? null;
}

export function runnerHealthCommandEnvelope(
  db: Database,
  commandId: string,
  runnerId: string,
): string | null {
  return settled(sqliteDb(db).run((q) => runnerHealthCommandEnvelopeSteps(q, commandId, runnerId)));
}

export function* pendingRunnerHealthCheckCountSteps(q: Q, runnerId: string, at: number) {
  const { runnerCommand: c, runnerHealthResult: h } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ count: count() })
      .from(c)
      .leftJoin(h, eq(h.commandId, c.id))
      .where(
        and(
          eq(c.runnerId, runnerId),
          inArray(c.kind, HEALTH_KINDS),
          gt(c.expiresAt, at),
          isNull(h.commandId),
        ),
      ),
  );
  return row!.count;
}

export function pendingRunnerHealthCheckCount(db: Database, runnerId: string, at: number): number {
  return settled(sqliteDb(db).run((q) => pendingRunnerHealthCheckCountSteps(q, runnerId, at)));
}

export function* runnerHealthCommandOutstandingSteps(q: Q, runnerId: string, at: number) {
  const { runnerCommand: c, runnerHealthResult: h, runnerLogin: l } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: c.id })
      .from(c)
      .leftJoin(h, eq(h.commandId, c.id))
      .where(
        and(
          eq(c.runnerId, runnerId),
          inArray(c.kind, [...HEALTH_KINDS, "login"]),
          gt(c.expiresAt, at),
          isNull(h.commandId),
          notExists(
            q.orm
              .select({ id: l.id })
              .from(l)
              .where(
                and(
                  eq(l.id, c.id),
                  inArray(l.state, ["connected", "failed", "cancelled", "expired"]),
                ),
              ),
          ),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export function runnerHealthCommandOutstanding(
  db: Database,
  runnerId: string,
  at: number,
): boolean {
  return settled(sqliteDb(db).run((q) => runnerHealthCommandOutstandingSteps(q, runnerId, at)));
}

export type RunnerLoginCheckRow = {
  id: string;
  envelope: string;
  expiresAt: number;
  receivedAt: number | null;
  resultJson: string | null;
};

export function* runnerLoginCheckHistorySteps(q: Q, runnerId: string) {
  const { runnerCommand: c, runnerHealthResult: h } = q.t;
  return yield* q.all(
    q.orm
      .select({
        id: c.id,
        envelope: jsonText(q, c.envelope),
        expiresAt: c.expiresAt,
        receivedAt: h.receivedAt,
        resultJson: h.resultJson,
      })
      .from(c)
      .leftJoin(h, eq(h.commandId, c.id))
      .where(and(eq(c.runnerId, runnerId), eq(c.kind, "login_check")))
      .orderBy(desc(c.ordinal))
      .limit(256),
  );
}

export function runnerLoginCheckHistory(db: Database, runnerId: string): RunnerLoginCheckRow[] {
  return settled(sqliteDb(db).run((q) => runnerLoginCheckHistorySteps(q, runnerId)));
}

export function* recentRunnerHealthChecksSteps(q: Q, runnerId: string) {
  const { runnerCommand: c, runnerHealthResult: h } = q.t;
  return yield* q.all(
    q.orm
      .select({
        id: c.id,
        expiresAt: c.expiresAt,
        receivedAt: h.receivedAt,
        resultJson: h.resultJson,
      })
      .from(c)
      .leftJoin(h, eq(h.commandId, c.id))
      .where(and(eq(c.runnerId, runnerId), inArray(c.kind, HEALTH_KINDS)))
      .orderBy(desc(c.ordinal))
      .limit(12),
  );
}

export function recentRunnerHealthChecks(
  db: Database,
  runnerId: string,
): Omit<RunnerLoginCheckRow, "envelope">[] {
  return settled(sqliteDb(db).run((q) => recentRunnerHealthChecksSteps(q, runnerId)));
}

export function* runnerHealthResultJsonSteps(q: Q, commandId: string, runnerId?: string) {
  const { runnerHealthResult: h } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ resultJson: h.resultJson })
      .from(h)
      .where(
        and(
          eq(h.commandId, commandId),
          runnerId === undefined ? undefined : eq(h.runnerId, runnerId),
        ),
      ),
  );
  return row?.resultJson ?? null;
}

export function runnerHealthResultJson(
  db: Database,
  commandId: string,
  runnerId?: string,
): string | null {
  return settled(sqliteDb(db).run((q) => runnerHealthResultJsonSteps(q, commandId, runnerId)));
}

type NewRunnerHealthResult = {
  commandId: string;
  runnerId: string;
  resultJson: string;
  receivedAt: number;
};

export function* insertRunnerHealthResultSteps(q: Q, input: NewRunnerHealthResult) {
  yield* q.exec(q.orm.insert(q.t.runnerHealthResult).values(input));
}

export function insertRunnerHealthResult(db: Database, input: NewRunnerHealthResult): void {
  settled(sqliteDb(db).run((q) => insertRunnerHealthResultSteps(q, input)));
}
