import {
  exeDevTokenStatus,
  tailscaleAuthKeyStatus,
  vmProviderTokenStatus,
  type ExeDevTokenStatus,
} from "../config";
import {
  deleteVmProviderCheckSteps,
  putVmProviderCheckSteps,
  vmProviderCheckSteps,
  VM_PROVIDER_KEY_NAMES,
  type Db,
  type VmProviderCheckRow,
  type VmProviderCheckState,
  type VmProviderFact,
  type VmProviderKeyName,
} from "../db";
import { journal } from "../journal";

export const VM_PROVIDER_CHECK_JOB = "vm-provider.check";
export const VM_PROVIDER_CHECK_EVERY_MS = 21_600_000;
export const VM_PROVIDER_CHECK_TIMEOUT_MS = 10_000;

export type VmProviderCheckResult = {
  state: VmProviderCheckState;
  message: string;
  facts: VmProviderFact[];
};

export type VmProviderKeyCheck = (signal: AbortSignal) => Promise<VmProviderCheckResult>;

export type VmProviderChecksOptions = {
  db: Db;
  home: string;
  checks: Partial<Record<VmProviderKeyName, VmProviderKeyCheck>>;
  now?: () => number;
  timeoutMs?: number;
};

export type VmProviderChecks = {
  checkVmProviderKey(
    name: VmProviderKeyName,
    signal: AbortSignal,
  ): Promise<VmProviderCheckResult | null>;
  runVmProviderCheck(
    name: VmProviderKeyName,
    signal?: AbortSignal,
  ): Promise<VmProviderCheckRow | null>;
  runVmProviderChecks(signal?: AbortSignal): Promise<void>;
};

const KEY_STATUS: Record<VmProviderKeyName, (home: string) => ExeDevTokenStatus> = {
  "exe-dev": exeDevTokenStatus,
  boat: (home) => vmProviderTokenStatus(home, "boat"),
  instabox: (home) => vmProviderTokenStatus(home, "instabox"),
  tailscale: tailscaleAuthKeyStatus,
};

export function createVmProviderChecks(options: VmProviderChecksOptions): VmProviderChecks {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? VM_PROVIDER_CHECK_TIMEOUT_MS;

  async function checkVmProviderKey(name: VmProviderKeyName, signal: AbortSignal) {
    const check = options.checks[name];
    if (check === undefined) return null;
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
    const late = Promise.withResolvers<VmProviderCheckResult>();
    const onAbort = () => {
      const message = `The ${name} check did not finish within ${timeoutMs / 1000} s.`;
      late.resolve({
        state: "unreachable",
        message,
        facts: [{ name: "key", text: message, level: "error" }],
      });
    };
    if (bounded.aborted) onAbort();
    bounded.addEventListener("abort", onAbort, { once: true });
    try {
      return await Promise.race([check(bounded), late.promise]);
    } finally {
      bounded.removeEventListener("abort", onAbort);
    }
  }

  async function runVmProviderCheck(
    name: VmProviderKeyName,
    signal = new AbortController().signal,
  ) {
    if (KEY_STATUS[name](options.home) !== "readable") {
      await options.db.run((q) => deleteVmProviderCheckSteps(q, name));
      return null;
    }
    const result = await checkVmProviderKey(name, signal);
    if (result === null) return null;
    return saveVmProviderCheck(options.db, name, result, now());
  }

  async function runVmProviderChecks(signal?: AbortSignal) {
    for (const name of VM_PROVIDER_KEY_NAMES) {
      if (signal?.aborted) return;
      await runVmProviderCheck(name, signal);
    }
  }

  return { checkVmProviderKey, runVmProviderCheck, runVmProviderChecks };
}

export async function saveVmProviderCheck(
  db: Db,
  name: VmProviderKeyName,
  result: VmProviderCheckResult,
  at: number,
): Promise<VmProviderCheckRow> {
  const previous = await db.run((q) => vmProviderCheckSteps(q, name));
  const works = result.state === "working" || result.state === "limited";
  const row: VmProviderCheckRow = {
    name,
    ...result,
    checkedAt: at,
    lastWorkingAt: works ? at : (previous?.lastWorkingAt ?? null),
  };
  await db.run((q) => putVmProviderCheckSteps(q, row));
  if (previous?.state !== row.state)
    journal(`vm provider key ${name}: ${previous?.state ?? "unchecked"} -> ${row.state}`);
  return row;
}
