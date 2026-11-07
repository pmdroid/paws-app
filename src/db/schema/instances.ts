import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { run } from "./items";

export const instance = sqliteTable(
  "instance",
  {
    id: text().primaryKey().notNull(),
    role: text().notNull(),
    host: text().notNull(),
    startedAt: integer("started_at").notNull(),
    heartbeatAt: integer("heartbeat_at").notNull(),
    version: text(),
    pid: integer(),
  },
  (table) => [
    index("instance_heartbeat").on(table.heartbeatAt),
    check("instance_role", sql`role IN ('all', 'web', 'worker')`),
  ],
);

/** The instance that runs a run's turns. No reference to `instance`: a stopped instance's row goes. */
export const runOwner = sqliteTable(
  "run_owner",
  {
    runId: text("run_id")
      .primaryKey()
      .notNull()
      .references(() => run.id),
    ownerInstance: text("owner_instance").notNull(),
  },
  (table) => [index("run_owner_instance").on(table.ownerInstance)],
);
