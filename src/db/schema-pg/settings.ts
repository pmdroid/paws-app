import { bigint, pgTable, text } from "drizzle-orm/pg-core";

export const setting = pgTable("setting", {
  key: text().primaryKey(),
  value: text().notNull(),
  updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
});
