import { and, asc, eq, isNull, like } from "drizzle-orm";
import type { Q, Steps } from "./db";
import { jsonField } from "./json-text";
import { ulid } from "./ulid";

export type SlackThreadIdentity = {
  workspaceId: string;
  teamId: string;
  installGeneration: number;
  channelId: string;
  threadTs: string;
};

export type SlackConversation = SlackThreadIdentity & {
  id: string;
  appId: string | null;
  startedBySlackUserId: string;
  startedEventId: string;
  replyChannelId: string;
  replyThreadTs: string;
  workItemId: string | null;
  issueId: string | null;
  stoppedTs: string | null;
  stoppedBySlackUserId: string | null;
};

function* findSlackConversationSteps(q: Q, thread: SlackThreadIdentity) {
  const table = q.t.slackConversation;
  const fields = ["workspaceId", "teamId", "installGeneration", "channelId", "threadTs"] as const;
  return yield* q.one(
    q.orm
      .select()
      .from(table)
      .where(and(...fields.map((name) => eq(table[name], thread[name])))),
  );
}

export function* slackConversationSteps(
  q: Q,
  thread: SlackThreadIdentity,
): Steps<SlackConversation | null> {
  return (yield* findSlackConversationSteps(q, thread)) ?? null;
}

export function* recordSlackConversationSteps(
  q: Q,
  input: SlackThreadIdentity & { appId: string | null; slackUserId: string; eventId: string },
  now: number,
): Steps<SlackConversation> {
  const { slackUserId, eventId, ...thread } = input;
  yield* q.exec(
    q.orm
      .insert(q.t.slackConversation)
      .values({
        ...thread,
        id: ulid(now),
        startedBySlackUserId: slackUserId,
        startedEventId: eventId,
        replyChannelId: thread.channelId,
        replyThreadTs: thread.threadTs,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing(),
  );
  return (yield* findSlackConversationSteps(q, thread))!;
}

export function* stopSlackConversationSteps(
  q: Q,
  input: { id: string; ts: string; slackUserId: string },
  now: number,
): Steps<void> {
  const table = q.t.slackConversation;
  yield* q.exec(
    q.orm
      .update(table)
      .set({ stoppedTs: input.ts, stoppedBySlackUserId: input.slackUserId, updatedAt: now })
      .where(eq(table.id, input.id)),
  );
}

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
