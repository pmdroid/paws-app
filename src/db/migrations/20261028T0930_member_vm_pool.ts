import type { Migration } from "../migration";

/** The exe.dev pool a member chose for their VM in Create VM. Null: `[member_vm] pool`. */
export const migration: Migration = {
  id: "20261028T0930_member_vm_pool",
  sql: `ALTER TABLE member_vm ADD COLUMN pool TEXT;`,
};
