import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Mirrors the table `createHealthStore` makes in the runner's `health.db`. */
export const healthExecution = sqliteTable("health_execution", {
  id: text("id").primaryKey(),
  commandId: text("command_id").notNull().unique(),
  payload: text("payload").notNull(),
  phase: text("phase").notNull(),
  result: text("result"),
});
