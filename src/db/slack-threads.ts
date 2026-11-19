import { and, asc, eq, isNull, like } from "drizzle-orm";
import type { Q, Steps } from "./db";
import { jsonField } from "./json-text";

export function* takeSettingSteps(q: Q, key: string): Steps<string | null> {
  const { setting } = q.t;
  const row = yield* q.one(
    q.orm.delete(setting).where(eq(setting.key, key)).returning({ value: setting.value }),
  );
  return row?.value ?? null;
}

export function* settingsWithPrefixSteps(q: Q, prefix: string) {
  const { setting } = q.t;
  const pattern = `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
  return yield* q.all(
    q.orm
      .select({ key: setting.key, value: setting.value })
      .from(setting)
      .where(like(setting.key, pattern)),
  );
}

export function* slackOutboxExistsSteps(q: Q, idempotencyKey: string): Steps<boolean> {
  const { outbox } = q.t;
  const query = q.orm.select({ id: outbox.id }).from(outbox);
  return (yield* q.one(query.where(eq(outbox.idempotencyKey, idempotencyKey)))) !== undefined;
}

export function* slackThreadContextSteps(
  q: Q,
  scope: Record<"workspaceId" | "teamId" | "channelId" | "threadTs" | "userId", string> & {
    generation: number;
  },
): Steps<unknown[]> {
  const { outbox } = q.t;
  const fields = Object.entries({ ...scope, generation: String(scope.generation) });
  const rows = yield* q.all(
    q.orm
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(
        and(
          eq(outbox.target, "slack"),
          eq(outbox.op, "chat.postMessage"),
          eq(outbox.status, "sent"),
          ...fields.map(([name, value]) => eq(jsonField(q, outbox.payload, name), value)),
        ),
      )
      .orderBy(asc(outbox.id)),
  );
  return rows.map((row) => row.payload);
}

type Held = { id: number; lockedBy: string | null; attempts: number };

function held(q: Q, row: Held) {
  const { outbox } = q.t;
  return and(
    eq(outbox.id, row.id),
    eq(outbox.status, "pending"),
    row.lockedBy === null ? isNull(outbox.lockedBy) : eq(outbox.lockedBy, row.lockedBy),
    eq(outbox.attempts, row.attempts),
  );
}

export function* slackSendingSteps(q: Q, row: Held, sending: boolean): Steps<boolean> {
  const { outbox } = q.t;
  const from = sending ? isNull(outbox.externalId) : eq(outbox.externalId, "sending");
  const updated = yield* q.all(
    q.orm
      .update(outbox)
      .set({ externalId: sending ? "sending" : null })
      .where(and(held(q, row), from))
      .returning({ id: outbox.id }),
  );
  return updated.length === 1;
}

export type SlackSendOutcome =
  | { kind: "sent"; ts: string }
  | { kind: "unknown" | "withheld" | "refused"; note: string };

export function* settleSlackOutboxSteps(
  q: Q,
  row: Held,
  outcome: SlackSendOutcome,
  now: number,
): Steps<void> {
  const sent = outcome.kind === "sent";
  yield* q.exec(
    q.orm
      .update(q.t.outbox)
      .set({
        status: sent ? "sent" : "dropped",
        externalId: sent ? outcome.ts : outcome.kind,
        error: sent ? null : outcome.note,
        sentAt: sent ? now : null,
        lockedBy: null,
        lockedUntil: null,
      })
      .where(held(q, row)),
  );
}
