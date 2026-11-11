import {
  bigint,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { jsonb } from "./types";
import { sql } from "drizzle-orm";
import { run } from "./items";

export const outbox = pgTable(
  "outbox",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    target: text().notNull(),
    op: text().notNull(),
    orderingKey: text("ordering_key"),
    critical: bigint({ mode: "number" }).default(1).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb().notNull(),
    ephemeral: bigint({ mode: "number" }).default(0).notNull(),
    priority: bigint({ mode: "number" }).default(5).notNull(),
    notBefore: bigint("not_before", { mode: "number" }).default(0).notNull(),
    attempts: bigint({ mode: "number" }).default(0).notNull(),
    status: text().default("pending").notNull(),
    externalId: text("external_id"),
    error: text(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    sentAt: bigint("sent_at", { mode: "number" }),
    lockedBy: text("locked_by"),
    lockedUntil: bigint("locked_until", { mode: "number" }),
    maxAttempts: bigint("max_attempts", { mode: "number" }).default(5).notNull(),
    deliveryKind: text("delivery_kind").default("ordered").notNull(),
    deliveryGeneration: bigint("delivery_generation", { mode: "number" }).default(0).notNull(),
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
    check("outbox_check_3", sql`status IN ('pending', 'sent', 'dead', 'dropped')`),
    check(
      "outbox_check_4",
      sql`delivery_kind IN ('ordered', 'progress', 'critical', 'terminal', 'stop', 'status')`,
    ),
  ],
);

export const inboxEvent = pgTable(
  "inbox_event",
  {
    dedupeKey: text("dedupe_key").primaryKey(),
    deliveryId: text("delivery_id"),
    source: text().notNull(),
    action: text().notNull(),
    sessionId: text("session_id"),
    issueId: text("issue_id"),
    activityId: text("activity_id"),
    body: text(),
    signal: text(),
    updatedAtMs: bigint("updated_at_ms", { mode: "number" }).notNull(),
    payload: jsonb().notNull(),
    receivedAt: bigint("received_at", { mode: "number" }).notNull(),
    handled: integer().default(0).notNull(),
    attempts: bigint({ mode: "number" }).default(0).notNull(),
    nextAttemptAt: bigint("next_attempt_at", { mode: "number" }),
    lastError: text("last_error"),
    lockedBy: text("locked_by"),
    lockedUntil: bigint("locked_until", { mode: "number" }),
  },
  (table) => [
    uniqueIndex("inbox_event_delivery")
      .on(table.deliveryId)
      .where(sql`delivery_id IS NOT NULL`),
    index("inbox_event_issue")
      .on(sql`(payload->'data'->>'id')`, table.updatedAtMs)
      .where(sql`(payload->>'type')='Issue'`),
    index("inbox_event_session").on(table.sessionId, table.receivedAt),
    index("inbox_event_unhandled").on(table.handled, table.receivedAt),
    check("inbox_event_check_1", sql`source IN ('webhook', 'poll')`),
    check("inbox_event_check_2", sql`action IN ('created', 'prompted', 'other')`),
    check("inbox_event_check_4", sql`handled IN (0, 1)`),
  ],
);

export const outboxSessionFence = pgTable(
  "outbox_session_fence",
  {
    target: text().notNull(),
    orderingKey: text("ordering_key").notNull(),
    generation: bigint({ mode: "number" }).default(0).notNull(),
    stopped: integer().default(0).notNull(),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.target, table.orderingKey],
      name: "outbox_session_fence_target_ordering_key_pk",
    }),
    check("outbox_session_fence_check_1", sql`stopped IN (0, 1)`),
  ],
);
