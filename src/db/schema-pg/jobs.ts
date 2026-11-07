import { bigint, check, index, integer, jsonb, pgTable, text, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workItem } from "./items";
import { linearSession } from "./linear";

export const job = pgTable(
  "job",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    queue: text().notNull(),
    jobKey: text("job_key"),
    payload: jsonb().default({}).notNull(),
    priority: bigint({ mode: "number" }).default(5).notNull(),
    runAt: bigint("run_at", { mode: "number" }).notNull(),
    status: text().default("pending").notNull(),
    attempts: bigint({ mode: "number" }).default(0).notNull(),
    maxAttempts: bigint("max_attempts", { mode: "number" }).default(10).notNull(),
    lockedBy: text("locked_by"),
    lockedUntil: bigint("locked_until", { mode: "number" }),
    lastError: text("last_error"),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
    finishedAt: bigint("finished_at", { mode: "number" }),
    recurringEveryMs: bigint("recurring_every_ms", { mode: "number" }),
    fireCount: bigint("fire_count", { mode: "number" }).default(0).notNull(),
    lane: text().default("default").notNull(),
    itemVersion: bigint("item_version", { mode: "number" }),
    activationId: bigint("activation_id", { mode: "number" }).default(0).notNull(),
  },
  (table) => [
    unique().on(table.jobKey),
    index("job_due").on(table.status, table.runAt, table.priority),
    check("job_check_2", sql`status IN ('pending', 'running', 'done', 'dead', 'cancelled')`),
  ],
);

export const syncCursor = pgTable("sync_cursor", {
  name: text().primaryKey(),
  cursorMs: bigint("cursor_ms", { mode: "number" }).notNull(),
});

export const wake = pgTable("wake", {
  fromWall: bigint("from_wall", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  toWall: bigint("to_wall", { mode: "number" }).notNull(),
  sleptMs: bigint("slept_ms", { mode: "number" }).notNull(),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

export const schedulerAdmission = pgTable(
  "scheduler_admission",
  {
    itemId: text("item_id")
      .primaryKey()
      .references(() => workItem.id),
    jobId: bigint("job_id", { mode: "number" })
      .notNull()
      .references(() => job.id),
    projectKey: text("project_key").notNull(),
    repositoryKey: text("repository_key").notNull(),
    sessionId: text("session_id").references(() => linearSession.sessionId),
    paths: jsonb().notNull(),
    hot: integer().notNull(),
    createdAt: bigint("created_at", { mode: "number" }).notNull(),
  },
  (table) => [
    unique().on(table.jobId),
    index("scheduler_project").on(table.projectKey),
    check("scheduler_admission_check_2", sql`hot IN (0,1)`),
  ],
);

export const pawsAlive = pgTable(
  "paws_alive",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
    at: bigint({ mode: "number" }).notNull(),
  },
  () => [check("paws_alive_check_1", sql`id=1`)],
);

export const jobActivation = pgTable("job_activation", {
  id: bigint({ mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  jobId: bigint("job_id", { mode: "number" })
    .notNull()
    .references(() => job.id, { onDelete: "cascade" }),
});
