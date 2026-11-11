import { and, desc, eq, gt, inArray, isNull, like, lt, lte, max, or, sql } from "drizzle-orm";
import { type Q, type Steps } from "./db";
import { jsonFromText, jsonText } from "./json-text";
import { enqueueOutboxOnceSteps } from "./outbox";

export function* sessionFenceGenerationSteps(q: Q, sessionId: string): Steps<number> {
  const f = q.t.outboxSessionFence;
  const row = yield* q.one(
    q.orm
      .select({ generation: f.generation })
      .from(f)
      .where(and(eq(f.target, "linear"), eq(f.orderingKey, sessionId))),
  );
  return row?.generation ?? 0;
}

export type SessionMetadataPublish = {
  sessionId: string;
  generation: number;
  op: string;
  field: "plan" | "summary";
  value: unknown;
  payload: Record<string, unknown>;
  final: boolean;
  idempotencyKey: string;
  intervalMs: number;
  at: number;
};

export function* publishSessionMetadataSteps(q: Q, input: SessionMetadataPublish) {
  const o = q.t.outbox;
  const scope = and(
    eq(o.target, "linear"),
    eq(o.orderingKey, input.sessionId),
    eq(o.deliveryGeneration, input.generation),
  );
  const inFlight = and(eq(o.status, "pending"), gt(o.lockedUntil, input.at));
  const pending = yield* q.one(
    q.orm
      .select({ id: o.id })
      .from(o)
      .where(
        and(
          scope,
          eq(o.op, input.op),
          eq(o.status, "pending"),
          or(isNull(o.lockedUntil), lte(o.lockedUntil, input.at)),
        ),
      )
      .orderBy(desc(o.id))
      .limit(1),
  );
  const delivered = yield* q.one(
    q.orm
      .select({ payload: jsonText(q, o.payload) })
      .from(o)
      .where(and(scope, eq(o.op, input.op), or(eq(o.status, "sent"), inFlight)))
      .orderBy(desc(o.id))
      .limit(1),
  );
  if (
    delivered !== undefined &&
    JSON.stringify((JSON.parse(delivered.payload) as Record<string, unknown>)[input.field]) ===
      JSON.stringify(input.value)
  ) {
    if (pending)
      yield* q.exec(
        q.orm
          .update(o)
          .set({ status: "dropped", error: "Matches the session metadata already sent." })
          .where(eq(o.id, pending.id)),
      );
    return;
  }
  if (pending) {
    yield* q.exec(
      q.orm
        .update(o)
        .set({
          payload: jsonFromText(q, JSON.stringify(input.payload)),
          ...(input.final ? { notBefore: 0 } : {}),
        })
        .where(eq(o.id, pending.id)),
    );
    return;
  }
  const last = yield* q.one(
    q.orm
      .select({
        at: max(sql<number>`CASE WHEN ${o.status} = 'sent' THEN ${o.sentAt} ELSE ${input.at} END`),
      })
      .from(o)
      .where(and(scope, like(o.op, "linear.session.%"), or(eq(o.status, "sent"), inFlight))),
  );
  const lastAt = last?.at == null ? null : Number(last.at);
  const id = yield* enqueueOutboxOnceSteps(q, {
    target: "linear",
    op: input.op,
    orderingKey: input.sessionId,
    priority: 6,
    generation: input.generation,
    idempotencyKey: input.idempotencyKey,
    payload: input.payload,
    notBefore: input.final || lastAt === null ? 0 : lastAt + input.intervalMs,
    now: input.at,
  });
  yield* q.exec(
    q.orm
      .update(o)
      .set({ status: "dropped", error: "Superseded by a newer session metadata version." })
      .where(and(scope, eq(o.op, input.op), lt(o.id, id), eq(o.status, "dead"))),
  );
}

export function* sessionLinkQueuedSteps(
  q: Q,
  sessionId: string,
  generation: number,
  url: string,
): Steps<boolean> {
  const o = q.t.outbox;
  const first =
    q.dialect === "sqlite"
      ? sql`json_extract(${o.payload}, '$.addedExternalUrls[0].url')`
      : sql`(${o.payload} -> 'addedExternalUrls' -> 0 ->> 'url')`;
  const row = yield* q.one(
    q.orm
      .select({ id: o.id })
      .from(o)
      .where(
        and(
          eq(o.target, "linear"),
          eq(o.op, "linear.session.links"),
          eq(o.orderingKey, sessionId),
          eq(o.deliveryGeneration, generation),
          inArray(o.status, ["pending", "sent"]),
          sql`${first} = ${url}`,
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}
