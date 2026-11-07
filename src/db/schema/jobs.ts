import { check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { workItem } from "./items";
import { linearSession } from "./linear";

export const job = sqliteTable(
  "job",
  {
    id: integer().primaryKey(),
    queue: text().notNull(),
    jobKey: text("job_key"),
    payload: text().default("{}").notNull(),
    priority: integer().default(5).notNull(),
    runAt: integer("run_at").notNull(),
    status: text().default("pending").notNull(),
    attempts: integer().default(0).notNull(),
    maxAttempts: integer("max_attempts").default(10).notNull(),
    lockedBy: text("locked_by"),
    lockedUntil: integer("locked_until"),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
    recurringEveryMs: integer("recurring_every_ms"),
    fireCount: integer("fire_count").default(0).notNull(),
    lane: text().default("default").notNull(),
    itemVersion: integer("item_version"),
    activationId: integer("activation_id").default(0).notNull(),
  },
  (table) => [
    unique().on(table.jobKey),
    index("job_due").on(table.status, table.runAt, table.priority),
    check("job_check_1", sql`json_valid(payload)`),
    check("job_check_2", sql`status IN ('pending', 'running', 'done', 'dead', 'cancelled')`),
  ],
);

export const syncCursor = sqliteTable("sync_cursor", {
  name: text().primaryKey().notNull(),
  cursorMs: integer("cursor_ms").notNull(),
});

export const wake = sqliteTable("wake", {
  fromWall: integer("from_wall").primaryKey(),
  toWall: integer("to_wall").notNull(),
  sleptMs: integer("slept_ms").notNull(),
  createdAt: integer("created_at").notNull(),
});

export const schedulerAdmission = sqliteTable(
  "scheduler_admission",
  {
    itemId: text("item_id")
      .primaryKey()
      .notNull()
      .references(() => workItem.id),
    jobId: integer("job_id")
      .notNull()
      .references(() => job.id),
    projectKey: text("project_key").notNull(),
    repositoryKey: text("repository_key").notNull(),
    sessionId: text("session_id").references(() => linearSession.sessionId),
    paths: text().notNull(),
    hot: integer().notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    unique().on(table.jobId),
    index("scheduler_project").on(table.projectKey),
    check("scheduler_admission_check_1", sql`json_valid(paths)`),
    check("scheduler_admission_check_2", sql`hot IN (0,1)`),
  ],
);

export const pawsAlive = sqliteTable(
  "paws_alive",
  {
    id: integer().primaryKey(),
    at: integer().notNull(),
  },
  () => [check("paws_alive_check_1", sql`id=1`)],
);

export const jobActivation = sqliteTable("job_activation", {
  id: integer().primaryKey({ autoIncrement: true }),
  jobId: integer("job_id")
    .notNull()
    .references(() => job.id, { onDelete: "cascade" }),
});
