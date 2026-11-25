import type { MemberVmProviderName } from "../config";
import { vmProviderCheckSteps, type Db } from "../db";

export type VmProviderUsability = { usable: true } | { usable: false; reason: string };

export type VmProviderUsabilitySource = {
  store: Db;
  keySaved: (id: MemberVmProviderName) => boolean | Promise<boolean>;
  offProviders: () => readonly MemberVmProviderName[] | undefined;
};

const PROVIDER_NAMES: Record<MemberVmProviderName, string> = {
  "exe-dev": "exe.dev",
  boat: "boat",
  instabox: "InstaBox",
};

const PAGE = "Settings › Runner VMs";

export async function usableVmProvider(
  id: MemberVmProviderName,
  source: VmProviderUsabilitySource,
): Promise<VmProviderUsability> {
  const name = PROVIDER_NAMES[id];
  if (!(await source.keySaved(id)))
    return { usable: false, reason: `${name} has no saved key; save one on ${PAGE}.` };
  if (source.offProviders()?.includes(id))
    return { usable: false, reason: `${name} is turned off on ${PAGE}.` };
  const check = await source.store.run((q) => vmProviderCheckSteps(q, id));
  if (check?.state === "rejected") {
    const at = new Date(check.checkedAt).toISOString().slice(11, 16);
    return {
      usable: false,
      reason: `${name} rejected its key at ${at} UTC; replace it on ${PAGE}.`,
    };
  }
  return { usable: true };
}
