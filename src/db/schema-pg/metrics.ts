import { bigint, doublePrecision, index, pgTable, text } from "drizzle-orm/pg-core";
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
