import { bigint, check, integer, pgTable, text } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { runner } from "./runners";

export const vmHost = pgTable(
  "vm_host",
  {
    runnerId: text("runner_id")
      .primaryKey()
      .references(() => runner.id),
    vmVcpus: integer("vm_vcpus").default(2).notNull(),
    vmMemoryGb: integer("vm_memory_gb").default(4).notNull(),
    vmDiskGb: integer("vm_disk_gb").default(30).notNull(),
    reserveVcpus: integer("reserve_vcpus").default(4).notNull(),
    reserveMemoryGb: integer("reserve_memory_gb").default(8).notNull(),
    slotCap: integer("slot_cap"),
    poolBytes: bigint("pool_bytes", { mode: "number" }),
    updatedAt: bigint("updated_at", { mode: "number" }).notNull(),
    updatedBy: text("updated_by").notNull(),
  },
  () => [
    check("vm_host_vm_vcpus", sql`vm_vcpus BETWEEN 1 AND 32`),
    check("vm_host_vm_memory_gb", sql`vm_memory_gb BETWEEN 1 AND 128`),
    check("vm_host_vm_disk_gb", sql`vm_disk_gb BETWEEN 10 AND 500`),
    check("vm_host_reserve_vcpus", sql`reserve_vcpus BETWEEN 0 AND 64`),
    check("vm_host_reserve_memory_gb", sql`reserve_memory_gb BETWEEN 0 AND 256`),
    check("vm_host_slot_cap", sql`slot_cap IS NULL OR slot_cap BETWEEN 1 AND 64`),
  ],
);
