import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, isNull, min, notInArray, or, sql } from "drizzle-orm";
import { JOB_KIND, parentIssueIdSql } from "../core";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { jsonValue } from "./json-text";

const DONE_STATES = ["completed", "merged", "cancelled"];

export function* openQuestionThreadsSteps(q: Q) {
  const { question, workItem } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ session_id: question.sessionId, created_at: min(question.createdAt) })
      .from(question)
      .innerJoin(workItem, eq(workItem.id, question.itemId))
      .where(
        and(
          eq(question.status, "open"),
          isNull(question.cancelledAt),
          eq(workItem.state, "awaiting_input"),
        ),
      )
      .groupBy(question.sessionId)
      .orderBy(asc(question.sessionId)),
  );
  return rows.map((row) => ({ session_id: row.session_id!, created_at: row.created_at! }));
}

export function openQuestionThreads(db: Database): { session_id: string; created_at: number }[] {
  return settled(sqliteDb(db).run((q) => openQuestionThreadsSteps(q)));
}

function* anyItemSteps(q: Q, where: ReturnType<typeof and>): Steps<boolean> {
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(q.t.workItem)
      .where(where)
      .limit(1),
  );
  return row !== undefined;
}

export function* sessionHasWorkItemSteps(q: Q, sessionId: string) {
  return yield* anyItemSteps(q, eq(q.t.workItem.sessionKey, sessionId));
}

export function sessionHasWorkItem(db: Database, sessionId: string): boolean {
  return settled(sqliteDb(db).run((q) => sessionHasWorkItemSteps(q, sessionId)));
}

export function* issueHasItemOutsideSteps(q: Q, issueId: string, closedStates: readonly string[]) {
  const { workItem: w } = q.t;
  return yield* anyItemSteps(
    q,
    and(eq(w.linearIssueId, issueId), notInArray(w.state, [...closedStates])),
  );
}

export function issueHasItemOutside(
  db: Database,
  issueId: string,
  closedStates: readonly string[] = DONE_STATES,
): boolean {
  return settled(sqliteDb(db).run((q) => issueHasItemOutsideSteps(q, issueId, closedStates)));
}

export function* sessionHasItemInStatesSteps(q: Q, sessionId: string, states: readonly string[]) {
  const { workItem: w } = q.t;
  return yield* anyItemSteps(q, and(eq(w.sessionKey, sessionId), inArray(w.state, [...states])));
}

export function sessionHasItemInStates(
  db: Database,
  sessionId: string,
  states: readonly string[],
): boolean {
  return settled(sqliteDb(db).run((q) => sessionHasItemInStatesSteps(q, sessionId, states)));
}

export function* openStopTargetsSteps(
  q: Q,
  linearIssueId: string | null,
  sessionId: string | null,
): Steps<string[]> {
  const { workItem: w } = q.t;
  const ids: string[] = [];
  const open = notInArray(w.state, DONE_STATES);
  if (linearIssueId !== null && sessionId === null) {
    const parent = sql.raw(parentIssueIdSql("work_item", q.dialect));
    const rows = yield* q.all(
      q.orm
        .select({ id: w.id })
        .from(w)
        .where(and(open, or(eq(w.linearIssueId, linearIssueId), sql`${parent} = ${linearIssueId}`)))
        .orderBy(asc(w.position), asc(w.id)),
    );
    for (const row of rows) if (!ids.includes(row.id)) ids.push(row.id);
  }
  if (sessionId !== null) {
    const rows = yield* q.all(
      q.orm
        .select({ id: w.id })
        .from(w)
        .where(and(open, eq(w.sessionKey, sessionId)))
        .orderBy(asc(w.position), asc(w.id)),
    );
    for (const row of rows) if (!ids.includes(row.id)) ids.push(row.id);
  }
  return ids;
}

export function openStopTargets(
  db: Database,
  linearIssueId: string | null,
  sessionId: string | null,
): string[] {
  return settled(sqliteDb(db).run((q) => openStopTargetsSteps(q, linearIssueId, sessionId)));
}

export function* latestOpenIssueSessionSteps(q: Q, issueId: string) {
  const { linearSession: s } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ sessionId: s.sessionId, createdAt: s.createdAt })
      .from(s)
      .where(and(eq(s.issueId, issueId), isNull(s.stoppedAt)))
      .orderBy(desc(s.createdAt))
      .limit(1),
  );
  return row ?? null;
}

export function latestOpenIssueSession(
  db: Database,
  issueId: string,
): { sessionId: string; createdAt: number } | null {
  return settled(sqliteDb(db).run((q) => latestOpenIssueSessionSteps(q, issueId)));
}

export function* persistStopJobSteps(
  q: Q,
  command: { type: string; itemId: string; requestedAt: number },
) {
  yield* q.exec(
    q.orm
      .insert(q.t.job)
      .values({
        queue: JOB_KIND.command,
        jobKey: `cmd:${command.type}:${command.itemId}:${command.requestedAt}`,
        payload: jsonValue(q, command),
        priority: 0,
        runAt: command.requestedAt,
        maxAttempts: 10,
        createdAt: command.requestedAt,
        recurringEveryMs: null,
        lane: "default",
      })
      .onConflictDoNothing(),
  );
}

export function persistStopJob(
  db: Database,
  command: { type: string; itemId: string; requestedAt: number },
): void {
  settled(sqliteDb(db).run((q) => persistStopJobSteps(q, command)));
}
