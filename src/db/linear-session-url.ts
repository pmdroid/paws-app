import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { type Q, type Db } from "./db";

function sessionUrl(q: Q, payload: SQL): { url: SQL<string | null>; present: SQL } {
  const json = sql`COALESCE(NULLIF(${payload}->'agentSession'->'url', 'null'::jsonb),
    NULLIF(${payload}->'agentSession'->'issue'->'url', 'null'::jsonb))`;
  const url = sql<string | null>`(${json} #>> '{}')`;
  return { url, present: sql`jsonb_typeof(${json}) = 'string' AND length(${url}) > 0` };
}

export function* hasTableSteps(q: Q, name: string) {
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(sql`information_schema.tables`)
      .where(sql`table_schema = current_schema() AND table_name = ${name}`),
  );
  return row !== undefined;
}

export function* getLinearConversationSourceSteps(q: Q, sessionId: string) {
  const { inboxEvent, linearTurn } = q.t;
  if (yield* hasTableSteps(q, "inbox_event")) {
    const { url, present } = sessionUrl(q, sql`${inboxEvent.payload}`);
    const row = yield* q.one(
      q.orm
        .select({ url })
        .from(inboxEvent)
        .where(and(eq(inboxEvent.sessionId, sessionId), eq(inboxEvent.action, "created"), present))
        .orderBy(asc(inboxEvent.receivedAt))
        .limit(1),
    );
    if (row) return row.url;
  }
  if (yield* hasTableSteps(q, "linear_turn")) {
    const { url, present } = sessionUrl(q, sql`${linearTurn.payload}`);
    const row = yield* q.one(
      q.orm
        .select({ url })
        .from(linearTurn)
        .where(and(eq(linearTurn.sessionId, sessionId), present))
        .orderBy(asc(linearTurn.ordinal))
        .limit(1),
    );
    if (row) return row.url;
  }
  return null;
}

export async function getLinearConversationSource(
  store: Db,
  sessionId: string,
): Promise<string | null> {
  return store.run((q) => getLinearConversationSourceSteps(q, sessionId));
}
