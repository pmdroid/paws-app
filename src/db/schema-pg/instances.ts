import { bigint, check, index, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const instance = pgTable(
  "instance",
  {
    id: text().primaryKey(),
    role: text().notNull(),
    host: text().notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    heartbeatAt: bigint("heartbeat_at", { mode: "number" }).notNull(),
    version: text(),
  },
  (table) => [
    index("instance_heartbeat").on(table.heartbeatAt),
    check("instance_role", sql`role IN ('all', 'web', 'worker')`),
  ],
);
