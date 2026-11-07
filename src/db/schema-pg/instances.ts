import { bigint, check, index, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { run } from "./items";

export const instance = pgTable(
  "instance",
  {
    id: text().primaryKey(),
    role: text().notNull(),
    host: text().notNull(),
    startedAt: bigint("started_at", { mode: "number" }).notNull(),
    heartbeatAt: bigint("heartbeat_at", { mode: "number" }).notNull(),
    version: text(),
    pid: bigint({ mode: "number" }),
    stoppedAt: bigint("stopped_at", { mode: "number" }),
  },
  (table) => [
    index("instance_heartbeat").on(table.heartbeatAt),
    check("instance_role", sql`role IN ('all', 'web', 'worker')`),
  ],
);

export const runOwner = pgTable(
  "run_owner",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => run.id),
    ownerInstance: text("owner_instance").notNull(),
  },
  (table) => [index("run_owner_instance").on(table.ownerInstance)],
);
