import { and, asc, eq, isNotNull, isNull, like } from "drizzle-orm";
import type { Q, Steps } from "./db";
import { jsonField } from "./json-text";

export function* takeSettingSteps(q: Q, key: string): Steps<string | null> {
  const { setting } = q.t;
  const row = yield* q.one(
    q.orm.delete(setting).where(eq(setting.key, key)).returning({ value: setting.value }),
  );
  return row?.value ?? null;
}

export function* slackOutboxExistsSteps(q: Q, idempotencyKey: string): Steps<boolean> {
  const { outbox } = q.t;
  const row = yield* q.one(
    q.orm.select({ id: outbox.id }).from(outbox).where(eq(outbox.idempotencyKey, idempotencyKey)),
  );
  return row !== undefined;
}

export function* slackThreadContextSteps(
  q: Q,
  scope: {
    workspaceId: string;
    teamId: string;
    channelId: string;
    threadTs: string;
    userId: string;
    generation: number;
  },
): Steps<unknown[]> {
  const { outbox } = q.t;
  const field = (name: string) => jsonField(q, outbox.payload, name);
  const rows = yield* q.all(
    q.orm
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(
        and(
          eq(outbox.target, "slack"),
          eq(outbox.op, "chat.postMessage"),
          eq(outbox.status, "sent"),
          isNotNull(outbox.externalId),
          eq(field("workspaceId"), scope.workspaceId),
          eq(field("teamId"), scope.teamId),
          eq(field("channelId"), scope.channelId),
          eq(field("threadTs"), scope.threadTs),
          eq(field("userId"), scope.userId),
          eq(field("generation"), String(scope.generation)),
        ),
      )
      .orderBy(asc(outbox.id)),
  );
  return rows.map((row) => row.payload);
}

export type SlackSendOutcome =
  | { kind: "sent"; ts: string }
  | { kind: "unknown" | "withheld" | "refused"; note: string };

export function* settleSlackOutboxSteps(
  q: Q,
  row: { id: number; lockedBy: string | null; attempts: number },
  outcome: SlackSendOutcome,
  now: number,
): Steps<void> {
  const { outbox } = q.t;
  const sent = outcome.kind === "sent";
  yield* q.exec(
    q.orm
      .update(outbox)
      .set({
        status: sent ? "sent" : "dropped",
        externalId: sent ? outcome.ts : outcome.kind,
        error: sent ? null : outcome.note,
        sentAt: sent ? now : null,
        lockedBy: null,
        lockedUntil: null,
      })
      .where(
        and(
          eq(outbox.id, row.id),
          eq(outbox.status, "pending"),
          row.lockedBy === null ? isNull(outbox.lockedBy) : eq(outbox.lockedBy, row.lockedBy),
          eq(outbox.attempts, row.attempts),
        ),
      ),
  );
}

export function* settingsWithPrefixSteps(
  q: Q,
  prefix: string,
): Steps<{ key: string; value: string }[]> {
  const { setting } = q.t;
  return yield* q.all(
    q.orm
      .select({ key: setting.key, value: setting.value })
      .from(setting)
      .where(like(setting.key, `${prefix.replace(/[\\%_]/g, "\\$&")}%`)),
  );
}
