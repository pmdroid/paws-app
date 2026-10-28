import type { Database } from "bun:sqlite";
import { getOutbox, type OutboxRow } from "./outbox";

export function prepareLinearActivity(db: Database, message: OutboxRow): OutboxRow {
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
  const result = db.run(
    "UPDATE outbox SET payload = json_set(payload, '$.id', ?) WHERE id = ? AND status = 'pending' AND attempts = ? AND locked_by IS ?",
    [crypto.randomUUID(), message.id, message.attempts, message.lockedBy],
  );
  if (result.changes !== 1) throw new Error("The Linear activity changed before delivery");
  return getOutbox(db, message.id)!;
}
