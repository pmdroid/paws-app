import type { Database } from "bun:sqlite";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import type { WorkItemRecord } from "./items";
import { emitJobReady, reenqueueJobSteps } from "./jobs";

export const RESTART_QUESTION =
  "Paws lost this task's run more than once, through a restart or a runner that stopped answering. Start it again from its branch in a fresh session? Stop the session to leave it.";

export type RestartHold = { itemId: string; sessionId: string; requestedAt: number };

const HELD_STATES: readonly string[] = ["recovering", "awaiting_input"];

export function* restartHoldSteps(q: Q, item: WorkItemRecord): Steps<RestartHold | null> {
  if (item.sessionKey === null || item.cancelRequested || !HELD_STATES.includes(item.state))
    return null;
  const holds = q.t.restartHold;
  const row = yield* q.one(
    q.orm
      .select({
        itemId: holds.itemId,
        sessionId: holds.sessionId,
        requestedAt: holds.requestedAt,
      })
      .from(holds)
      .where(and(eq(holds.itemId, item.id), eq(holds.sessionId, item.sessionKey))),
  );
  return row ?? null;
}

export function restartHold(db: Database, item: WorkItemRecord): RestartHold | null {
  return settled(sqliteDb(db).run((q) => restartHoldSteps(q, item)));
}

export function* holdRestartSteps(q: Q, item: WorkItemRecord, now: number): Steps<void> {
  const holds = q.t.restartHold;
  const sessionId = item.sessionKey!;
  yield* q.exec(
    q.orm
      .insert(holds)
      .values({ itemId: item.id, sessionId, requestedAt: now })
      .onConflictDoUpdate({
        target: holds.itemId,
        set: { sessionId, requestedAt: now },
        setWhere: ne(holds.sessionId, sessionId),
      }),
  );
}

export function holdRestart(db: Database, item: WorkItemRecord, now: number): void {
  settled(sqliteDb(db).run((q) => holdRestartSteps(q, item, now)));
}

export function* restartQuestionStandsSteps(q: Q, item: WorkItemRecord): Steps<boolean> {
  const { question } = q.t;
  const row = yield* q.one(
    q.orm
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
      .limit(1),
  );
  return row !== undefined;
}

export function restartQuestionStands(db: Database, item: WorkItemRecord): boolean {
  return settled(sqliteDb(db).run((q) => restartQuestionStandsSteps(q, item)));
}

function payloadText(q: Q, key: "itemId" | "reason") {
  const { payload } = q.t.job;
  return q.dialect === "sqlite"
    ? sql`json_extract(${payload}, ${sql.raw(`'$.${key}'`)})`
    : sql`(${payload}->>${sql.raw(`'${key}'`)})`;
}

function* restartQuestionQueuedSteps(q: Q, itemId: string): Steps<boolean> {
  const { job } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(job)
      .where(
        and(
          eq(job.queue, "item.ask"),
          inArray(job.status, ["pending", "running"]),
          sql`${payloadText(q, "itemId")} = ${itemId}`,
          sql`${payloadText(q, "reason")} = 'restart'`,
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

/** Whether the item is held for a restart question, and whether this call armed its ask job. */
export function* ensureRestartQuestionSteps(
  q: Q,
  item: WorkItemRecord,
  now: number,
): Steps<{ held: boolean; armed: boolean }> {
  const hold = yield* restartHoldSteps(q, item);
  if (hold === null) return { held: false, armed: false };
  if (
    (yield* restartQuestionStandsSteps(q, item)) ||
    (yield* restartQuestionQueuedSteps(q, item.id))
  )
    return { held: true, armed: false };
  const { armed } = yield* reenqueueJobSteps(q, {
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
  return { held: true, armed };
}

export function ensureRestartQuestion(db: Database, item: WorkItemRecord, now: number): boolean {
  const { held, armed } = settled(
    sqliteDb(db).transaction((q) => ensureRestartQuestionSteps(q, item, now)),
  );
  if (armed) emitJobReady(db);
  return held;
}
