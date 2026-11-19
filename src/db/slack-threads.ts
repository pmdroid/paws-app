import { and, asc, eq, like } from "drizzle-orm";
import type { Q, Steps } from "./db";
import { jsonField } from "./json-text";

export function* takeSettingSteps(q: Q, key: string): Steps<string | null> {
  const { setting } = q.t;
  const row = yield* q.one(
    q.orm.delete(setting).where(eq(setting.key, key)).returning({ value: setting.value }),
  );
  return row?.value ?? null;
}

export function* slackThreadRepliesSteps(
  q: Q,
  thread: { teamId: string; channelId: string; threadTs: string },
): Steps<unknown[]> {
  const { outbox } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(
        and(
          eq(outbox.target, "slack"),
          eq(outbox.op, "chat.postMessage"),
          eq(jsonField(q, outbox.payload, "teamId"), thread.teamId),
          eq(jsonField(q, outbox.payload, "channelId"), thread.channelId),
          eq(jsonField(q, outbox.payload, "threadTs"), thread.threadTs),
        ),
      )
      .orderBy(asc(outbox.id)),
  );
  return rows.map((row) => row.payload);
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
