import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Mirrors the table `createRetroStore` makes in the runner's `retro.db`. */
export const retroExecution = sqliteTable("retro_execution", {
  id: text("id").primaryKey(),
  commandId: text("command_id").notNull().unique(),
  payload: text("payload").notNull(),
  phase: text("phase", {
    enum: ["preparing", "running", "reporting", "releasing", "complete"],
  }).notNull(),
  result: text("result"),
  startedAt: integer("started_at"),
});
