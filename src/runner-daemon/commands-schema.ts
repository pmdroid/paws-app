import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Mirrors the tables `createCommandStore` makes in the runner's `commands.db`. */
export const commandReceipt = sqliteTable("command_receipt", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at").notNull(),
});

export const pendingCommand = sqliteTable("pending_command", {
  id: text("id")
    .primaryKey()
    .references(() => commandReceipt.id),
  payload: text("payload").notNull(),
  acknowledged: integer("acknowledged").notNull().default(0),
});

export const pendingRetroCommand = sqliteTable("pending_retro_command", {
  id: text("id")
    .primaryKey()
    .references(() => commandReceipt.id),
  payload: text("payload").notNull(),
  delivered: integer("delivered").notNull().default(0),
});

export const retroAttempt = sqliteTable("retro_attempt", {
  retroId: text("retro_id").primaryKey(),
  attempt: integer("attempt").notNull(),
});
