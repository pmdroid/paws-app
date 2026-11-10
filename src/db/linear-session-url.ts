import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import { type Q, type Db } from "./db";

function sessionUrl(q: Q, payload: SQL): { url: SQL<string | null>; present: SQL } {
  if (q.dialect === "sqlite") {
    const url = sql<string | null>`CASE WHEN json_valid(${payload}) THEN
      COALESCE(json_extract(${payload}, '$.agentSession.url'), json_extract(${payload}, '$.agentSession.issue.url'))
      ELSE NULL END`;
    return { url, present: sql`typeof(${url}) = 'text' AND length(${url}) > 0` };
  }
  const json = sql`COALESCE(NULLIF(${payload}->'agentSession'->'url', 'null'::jsonb),
    NULLIF(${payload}->'agentSession'->'issue'->'url', 'null'::jsonb))`;
  const url = sql<string | null>`(${json} #>> '{}')`;
  return { url, present: sql`jsonb_typeof(${json}) = 'string' AND length(${url}) > 0` };
}

export function* hasTableSteps(q: Q, name: string) {
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(q.dialect === "sqlite" ? sql`sqlite_master` : sql`information_schema.tables`)
      .where(
        q.dialect === "sqlite"
          ? sql`type = 'table' AND name = ${name}`
          : sql`table_schema = current_schema() AND table_name = ${name}`,
      ),
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
