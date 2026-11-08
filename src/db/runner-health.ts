import type { Database } from "bun:sqlite";
import { and, eq, gt, inArray, isNull, notExists } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";

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
          inArray(c.kind, ["probe", "login_check", "login"]),
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
