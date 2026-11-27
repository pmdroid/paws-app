import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, max, or } from "drizzle-orm";
import { type Q } from "./db";

const FINAL = ["merged", "completed", "cancelled", "failed"];

export function* itemsToTraceSteps(q: Q, query: { since: number; limit: number }) {
  const { workItem: w, workItemEvent: e, traceExport: x } = q.t;
  const endedAt = max(e.at).mapWith(Number);
  return yield* q.all(
    q.orm
      .select({
        id: w.id,
        identifier: w.linearIdentifier,
        state: w.state,
        createdAt: w.createdAt,
        endedAt,
      })
      .from(w)
      .innerJoin(e, and(eq(e.itemId, w.id), eq(e.toState, w.state)))
      .leftJoin(x, eq(x.itemId, w.id))
      .where(inArray(w.state, FINAL))
      .groupBy(w.id, x.endedAt)
      .having(and(gte(endedAt, query.since), or(isNull(x.endedAt), lt(x.endedAt, endedAt))))
      .orderBy(asc(endedAt), asc(w.id))
      .limit(query.limit),
  );
}

export function* itemTraceRowsSteps(q: Q, itemId: string) {
  const { workItemEvent: e, run, closeoutStep: s, closeoutProgress: p } = q.t;
  const events = yield* q.all(
    q.orm
      .select({ at: e.at, fromState: e.fromState, toState: e.toState })
      .from(e)
      .where(eq(e.itemId, itemId))
      .orderBy(asc(e.version)),
  );
  const runs = yield* q.all(
    q.orm
      .select({ id: run.id, startedAt: run.createdAt, endedAt: run.updatedAt })
      .from(run)
      .where(eq(run.itemId, itemId))
      .orderBy(asc(run.createdAt), asc(run.id)),
  );
  const checks = yield* q.all(
    q.orm
      .select({ checkId: s.stepId, startedAt: s.startedAt, endedAt: s.finishedAt })
      .from(s)
      .innerJoin(p, eq(p.id, s.progressId))
      .where(and(eq(p.itemId, itemId), isNotNull(s.startedAt), isNotNull(s.finishedAt)))
      .orderBy(asc(s.startedAt)),
  );
  return {
    events,
    runs,
    checks: checks.map((row) => ({ ...row, startedAt: row.startedAt!, endedAt: row.endedAt! })),
  };
}

export function* markTraceExportedSteps(
  q: Q,
  row: { itemId: string; endedAt: number; exportedAt: number },
) {
  const { traceExport: x } = q.t;
  yield* q.exec(
    q.orm
      .insert(x)
      .values(row)
      .onConflictDoUpdate({
        target: x.itemId,
        set: { endedAt: row.endedAt, exportedAt: row.exportedAt },
      }),
  );
}
