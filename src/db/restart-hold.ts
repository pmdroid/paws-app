import type { Database } from "bun:sqlite";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { WorkItemRecord } from "./items";
import { reenqueueJob } from "./jobs";
import { orm } from "./orm";
import { job, question, restartHold as restartHoldTable } from "./schema";

export const RESTART_QUESTION =
  "Paws lost this task's run more than once, through a restart or a runner that stopped answering. Start it again from its branch in a fresh session? Stop the session to leave it.";

export type RestartHold = { itemId: string; sessionId: string; requestedAt: number };

const HELD_STATES: readonly string[] = ["recovering", "awaiting_input"];

export function restartHold(db: Database, item: WorkItemRecord): RestartHold | null {
  if (item.sessionKey === null || item.cancelRequested || !HELD_STATES.includes(item.state))
    return null;
  return (
    orm(db)
      .select({
        itemId: restartHoldTable.itemId,
        sessionId: restartHoldTable.sessionId,
        requestedAt: restartHoldTable.requestedAt,
      })
      .from(restartHoldTable)
      .where(
        and(eq(restartHoldTable.itemId, item.id), eq(restartHoldTable.sessionId, item.sessionKey)),
      )
      .get() ?? null
  );
}

export function holdRestart(db: Database, item: WorkItemRecord, now: number): void {
  const sessionId = item.sessionKey!;
  orm(db)
    .insert(restartHoldTable)
    .values({ itemId: item.id, sessionId, requestedAt: now })
    .onConflictDoUpdate({
      target: restartHoldTable.itemId,
      set: { sessionId, requestedAt: now },
      setWhere: ne(restartHoldTable.sessionId, sessionId),
    })
    .run();
}

export function restartQuestionStands(db: Database, item: WorkItemRecord): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(question)
      .where(
        and(
          eq(question.itemId, item.id),
          eq(question.sessionId, item.sessionKey!),
          eq(question.reason, "restart"),
          isNull(question.cancelledAt),
          or(
            inArray(question.status, ["open", "queued"]),
            and(eq(question.status, "answered"), isNull(question.handoffVersion)),
          ),
        ),
      )
      .get() !== undefined
  );
}

function restartQuestionQueued(db: Database, itemId: string): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(job)
      .where(
        and(
          eq(job.queue, "item.ask"),
          inArray(job.status, ["pending", "running"]),
          sql`json_extract(${job.payload}, '$.itemId') = ${itemId}`,
          sql`json_extract(${job.payload}, '$.reason') = 'restart'`,
        ),
      )
      .get() !== undefined
  );
}

export function ensureRestartQuestion(db: Database, item: WorkItemRecord, now: number): boolean {
  const hold = restartHold(db, item);
  if (hold === null) return false;
  if (restartQuestionStands(db, item) || restartQuestionQueued(db, item.id)) return true;
  reenqueueJob(db, {
    queue: "item.ask",
    jobKey: `restart-ask:${item.id}:${hold.requestedAt}`,
    payload: {
      itemId: item.id,
      kind: "agent",
      reason: "restart",
      body: RESTART_QUESTION,
      options: ["Start again"],
    },
    now,
  });
  return true;
}
