import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const instance = sqliteTable(
  "instance",
  {
    id: text().primaryKey().notNull(),
    role: text().notNull(),
    host: text().notNull(),
    startedAt: integer("started_at").notNull(),
    heartbeatAt: integer("heartbeat_at").notNull(),
    version: text(),
  },
  (table) => [
    index("instance_heartbeat").on(table.heartbeatAt),
    check("instance_role", sql`role IN ('all', 'web', 'worker')`),
  ],
);
