import { eq } from "drizzle-orm";
import { type Q } from "./db";

export const VM_PROVIDER_KEY_NAMES = ["exe-dev", "boat", "instabox", "tailscale"] as const;
export type VmProviderKeyName = (typeof VM_PROVIDER_KEY_NAMES)[number];

export type VmProviderCheckState = "working" | "limited" | "rejected" | "unreachable";

export type VmProviderFact = {
  name: "key" | "plan" | "sizes" | "vms" | "stopped_vms" | "join";
  text: string;
  level: "ok" | "warn" | "error";
};

export type VmProviderCheckRow = {
  name: VmProviderKeyName;
  state: VmProviderCheckState;
  message: string;
  facts: VmProviderFact[];
  checkedAt: number;
  lastWorkingAt: number | null;
};

export function* vmProviderChecksSteps(q: Q) {
  const rows = yield* q.all(q.orm.select().from(q.t.vmProviderCheck));
  return rows as VmProviderCheckRow[];
}

export function* vmProviderCheckSteps(q: Q, name: VmProviderKeyName) {
  const { vmProviderCheck: c } = q.t;
  const row = yield* q.one(q.orm.select().from(c).where(eq(c.name, name)));
  return (row ?? null) as VmProviderCheckRow | null;
}

export function* putVmProviderCheckSteps(q: Q, row: VmProviderCheckRow) {
  const { vmProviderCheck: c } = q.t;
  const { name: _name, ...rest } = row;
  yield* q.exec(q.orm.insert(c).values(row).onConflictDoUpdate({ target: c.name, set: rest }));
}

export function* deleteVmProviderCheckSteps(q: Q, name: VmProviderKeyName) {
  const { vmProviderCheck: c } = q.t;
  yield* q.exec(q.orm.delete(c).where(eq(c.name, name)));
}
