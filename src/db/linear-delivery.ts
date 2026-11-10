import { and, eq, isNull, sql } from "drizzle-orm";
import { type Q, type Db } from "./db";
import { getOutboxSteps, type OutboxRow } from "./outbox";

export function* prepareLinearActivitySteps(q: Q, message: OutboxRow) {
  if (
    message.target !== "linear" ||
    !["activity", "elicitation"].includes(message.op) ||
    message.orderingKey?.startsWith("github:") ||
    !message.payload ||
    typeof message.payload !== "object" ||
    Array.isArray(message.payload)
  )
    return message;
  const payload = message.payload as Record<string, unknown>;
  if (payload["id"] !== undefined) return message;
  const { outbox } = q.t;
  const id = crypto.randomUUID();
  const rows = yield* q.all(
    q.orm
      .update(outbox)
      .set({
        payload:
          q.dialect === "sqlite"
            ? sql`json_set(${outbox.payload}, '$.id', ${id})`
            : sql`jsonb_set(${outbox.payload}, '{id}', to_jsonb(${id}::text))`,
      })
      .where(
        and(
          eq(outbox.id, message.id),
          eq(outbox.status, "pending"),
          eq(outbox.attempts, message.attempts),
          message.lockedBy === null
            ? isNull(outbox.lockedBy)
            : eq(outbox.lockedBy, message.lockedBy),
        ),
      )
      .returning({ id: outbox.id }),
  );
  if (rows.length !== 1) throw new Error("The Linear activity changed before delivery");
  return (yield* getOutboxSteps(q, message.id))!;
}

export async function prepareLinearActivity(store: Db, message: OutboxRow): Promise<OutboxRow> {
  return store.run((q) => prepareLinearActivitySteps(q, message));
}
