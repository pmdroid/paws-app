import { bigint, check, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { jsonb } from "./types";

export const vmProviderCheck = pgTable(
  "vm_provider_check",
  {
    name: text().primaryKey(),
    state: text().notNull(),
    message: text().notNull(),
    facts: jsonb().notNull(),
    checkedAt: bigint("checked_at", { mode: "number" }).notNull(),
    lastWorkingAt: bigint("last_working_at", { mode: "number" }),
  },
  () => [
    check("vm_provider_check_name", sql`name IN ('exe-dev','boat','instabox','tailscale')`),
    check("vm_provider_check_state", sql`state IN ('working','limited','rejected','unreachable')`),
  ],
);
