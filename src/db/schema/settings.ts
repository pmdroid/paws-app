import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const setting = sqliteTable("setting", {
  key: text().primaryKey().notNull(),
  value: text().notNull(),
  updatedAt: integer("updated_at").notNull(),
});
