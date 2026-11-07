import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { run } from "./items";

export const outbox = sqliteTable(
  "outbox",
  {
    id: integer().primaryKey(),
    target: text().notNull(),
    op: text().notNull(),
    orderingKey: text("ordering_key"),
    critical: integer().default(1).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: text().notNull(),
    ephemeral: integer().default(0).notNull(),
    priority: integer().default(5).notNull(),
    notBefore: integer("not_before").default(0).notNull(),
    attempts: integer().default(0).notNull(),
    status: text().default("pending").notNull(),
    externalId: text("external_id"),
    error: text(),
    createdAt: integer("created_at").notNull(),
    sentAt: integer("sent_at"),
    lockedBy: text("locked_by"),
    lockedUntil: integer("locked_until"),
    maxAttempts: integer("max_attempts").default(5).notNull(),
    deliveryKind: text("delivery_kind").default("ordered").notNull(),
    deliveryGeneration: integer("delivery_generation").default(0).notNull(),
    activityRunId: text("activity_run_id").references(() => run.id),
  },
  (table) => [
    unique().on(table.idempotencyKey),
    index("outbox_activity_run").on(table.activityRunId, table.sentAt),
    index("outbox_due").on(table.status, table.target, table.notBefore, table.priority),
    index("outbox_session_delivery").on(
      table.target,
      table.orderingKey,
      table.deliveryGeneration,
      table.status,
    ),
    check("outbox_check_1", sql`target IN ('linear', 'slack', 'github', 'sandbox')`),
    check("outbox_check_2", sql`json_valid(payload)`),
    check("outbox_check_3", sql`status IN ('pending', 'sent', 'dead', 'dropped')`),
    check(
      "outbox_check_4",
      sql`delivery_kind IN ('ordered', 'progress', 'critical', 'terminal', 'stop', 'status')`,
    ),
  ],
);

export const inboxEvent = sqliteTable(
  "inbox_event",
  {
    dedupeKey: text("dedupe_key").primaryKey().notNull(),
    deliveryId: text("delivery_id"),
    source: text().notNull(),
    action: text().notNull(),
    sessionId: text("session_id"),
    issueId: text("issue_id"),
    activityId: text("activity_id"),
    body: text(),
    signal: text(),
    updatedAtMs: integer("updated_at_ms").notNull(),
    payload: text().notNull(),
    receivedAt: integer("received_at").notNull(),
    handled: integer().default(0).notNull(),
    attempts: integer().default(0).notNull(),
    nextAttemptAt: integer("next_attempt_at"),
    lastError: text("last_error"),
    lockedBy: text("locked_by"),
    lockedUntil: integer("locked_until"),
  },
  (table) => [
    uniqueIndex("inbox_event_delivery")
      .on(table.deliveryId)
      .where(sql`delivery_id IS NOT NULL`),
    index("inbox_event_issue")
      .on(sql`json_extract(payload,'$.data.id')`, table.updatedAtMs)
      .where(sql`json_extract(payload,'$.type')='Issue'`),
    index("inbox_event_session").on(table.sessionId, table.receivedAt),
    index("inbox_event_unhandled").on(table.handled, table.receivedAt),
    check("inbox_event_check_1", sql`source IN ('webhook', 'poll')`),
    check("inbox_event_check_2", sql`action IN ('created', 'prompted', 'other')`),
    check("inbox_event_check_3", sql`json_valid(payload)`),
    check("inbox_event_check_4", sql`handled IN (0, 1)`),
  ],
);

export const outboxSessionFence = sqliteTable(
  "outbox_session_fence",
  {
    target: text().notNull(),
    orderingKey: text("ordering_key").notNull(),
    generation: integer().default(0).notNull(),
    stopped: integer().default(0).notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.target, table.orderingKey],
      name: "outbox_session_fence_target_ordering_key_pk",
    }),
    check("outbox_session_fence_check_1", sql`stopped IN (0, 1)`),
  ],
);
