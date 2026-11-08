import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Mirrors the tables that `ddl` creates in each runner's local executions.db.
// Every table is STRICT there; Drizzle has no way to say so, and schema.test.ts checks it.

export const execution = sqliteTable("execution", {
  id: text("id").primaryKey(),
  commandId: text("command_id").notNull().unique(),
  payload: text("payload").notNull(),
  phase: text("phase").notNull(),
  consumed: integer("consumed").notNull().default(0),
  prefixHash: text("prefix_hash").notNull().default(""),
  answerCursor: integer("answer_cursor").notNull().default(0),
  transcriptOffset: integer("transcript_offset").notNull().default(0),
  sessionOffset: integer("session_offset").notNull().default(0),
  sessionState: text("session_state").$type<"" | "sealed" | "skipped">().notNull().default(""),
  transcriptSealed: integer("transcript_sealed").notNull().default(0),
});

export const delivery = sqliteTable(
  "delivery",
  {
    executionId: text("execution_id")
      .notNull()
      .references(() => execution.id),
    sequence: integer("sequence").notNull(),
    payload: text("payload").notNull(),
    requestId: text("request_id"),
    sent: integer("sent").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.executionId, table.sequence] }),
    index("delivery_waiting")
      .on(table.executionId, table.sequence)
      .where(sql`json_extract(payload,'$.type') IN ('question','artifact','closeout_policy')`),
  ],
);

export const resultDelivery = sqliteTable("result_delivery", {
  executionId: text("execution_id")
    .primaryKey()
    .references(() => execution.id),
  payload: text("payload").notNull(),
  failure: integer("failure").notNull(),
  accepted: integer("accepted").notNull().default(0),
  refused: text("refused"),
});

export const publication = sqliteTable("publication", {
  executionId: text("execution_id")
    .primaryKey()
    .references(() => execution.id),
  payload: text("payload").notNull(),
  lease: text("lease"),
  publishedSha: text("published_sha"),
  refused: text("refused"),
});

export const termination = sqliteTable(
  "termination",
  {
    commandId: text("command_id").primaryKey(),
    runId: text("run_id").notNull(),
    generation: integer("generation").notNull(),
    reported: integer("reported").notNull().default(0),
  },
  (table) => [index("termination_generation").on(table.runId, table.generation)],
);

export const cleanup = sqliteTable("cleanup", {
  executionId: text("execution_id")
    .primaryKey()
    .references(() => execution.id),
  startedAt: integer("started_at").notNull(),
  failures: integer("failures").notNull().default(0),
  failure: text("failure"),
  failedAt: integer("failed_at"),
});
