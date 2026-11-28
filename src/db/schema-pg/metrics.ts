import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  doublePrecision,
  index,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { workItem } from "./items";
import { jsonb } from "./types";

export const metricMinute = pgTable(
  "metric_minute",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    minute: bigint({ mode: "number" }).notNull(),
    name: text().notNull(),
    labels: jsonb().notNull(),
    count: doublePrecision().notNull(),
    sum: doublePrecision().notNull(),
    max: doublePrecision().notNull(),
    buckets: jsonb(),
    gauge: doublePrecision(),
  },
  (table) => [
    index("metric_minute_name").on(table.name, table.minute),
    index("metric_minute_minute").on(table.minute),
  ],
);

export const mergeWaitMark = pgTable(
  "merge_wait_mark",
  {
    itemId: text("item_id")
      .notNull()
      .references(() => workItem.id),
    head: text().notNull(),
    kind: text().notNull(),
    at: bigint({ mode: "number" }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.itemId, table.head, table.kind] }),
    check("merge_wait_mark_kind", sql`kind IN ('review_started','review_ended','enqueued')`),
  ],
);

export const traceExport = pgTable("trace_export", {
  itemId: text("item_id")
    .primaryKey()
    .references(() => workItem.id),
  endedAt: bigint("ended_at", { mode: "number" }).notNull(),
  exportedAt: bigint("exported_at", { mode: "number" }).notNull(),
});

export const exportedAlert = pgTable("exported_alert", {
  key: text().primaryKey(),
  severity: text().notNull(),
  title: text().notNull(),
  since: bigint({ mode: "number" }).notNull(),
  count: doublePrecision().notNull(),
});

export const alertEvent = pgTable("alert_event", {
  id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  eventId: text("event_id").notNull(),
  event: text().notNull(),
  key: text().notNull(),
  severity: text().notNull(),
  title: text().notNull(),
  since: bigint({ mode: "number" }).notNull(),
  count: doublePrecision().notNull(),
});
