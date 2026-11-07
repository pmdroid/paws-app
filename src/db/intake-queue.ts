import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { settled, sqliteDb, type Q } from "./db";

export type IntakeQueueEntry = {
  sessionId: string | null;
  issue: string;
  title: string | null;
  receivedAt: number;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
};

function jsonText(q: Q, json: SQL, path: readonly string[]): SQL {
  return q.dialect === "sqlite"
    ? sql`json_extract(${json}, ${`$.${path.join(".")}`})`
    : sql`(${json} #>> ${`{${path.join(",")}}`})`;
}

export function* listIntakeQueueSteps(q: Q) {
  const { inboxEvent: e, workItem } = q.t;
  const w = alias(workItem, "w");
  const latest = alias(workItem, "latest");
  const payload = sql`${e.payload}`;
  const rows = yield* q.all(
    q.orm
      .select({
        sessionId: e.sessionId,
        issue: sql<string>`COALESCE(${jsonText(q, payload, ["agentSession", "issue", "identifier"])},
          ${jsonText(q, payload, ["identifier"])},
          ${w.linearIdentifier}, ${e.issueId}, ${e.sessionId}, ${e.dedupeKey})`,
        title: sql<
          string | null
        >`COALESCE(${jsonText(q, payload, ["agentSession", "issue", "title"])}, ${w.title})`,
        receivedAt: e.receivedAt,
        attempts: e.attempts,
        nextAttemptAt: e.nextAttemptAt,
        lastError: e.lastError,
      })
      .from(e)
      .leftJoin(
        w,
        eq(
          w.id,
          q.orm
            .select({ id: latest.id })
            .from(latest)
            .where(or(eq(latest.sessionKey, e.sessionId), eq(latest.linearIssueId, e.issueId)))
            .orderBy(desc(latest.createdAt))
            .limit(1),
        ),
      )
      .where(
        and(
          eq(e.handled, 0),
          inArray(e.action, ["created", "prompted"]),
          or(isNull(e.signal), ne(e.signal, "stop")),
        ),
      )
      .orderBy(asc(e.receivedAt), asc(e.dedupeKey)),
  );
  return rows as IntakeQueueEntry[];
}

export function listIntakeQueue(db: Database): IntakeQueueEntry[] {
  return settled(sqliteDb(db).run(listIntakeQueueSteps));
}
