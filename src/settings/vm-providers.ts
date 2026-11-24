import {
  loadConfigFile,
  MEMBER_VM_PROVIDERS,
  writeMemberVmSize,
  type MemberVmProviderName,
} from "../config";
import {
  vmProviderCheckSteps,
  VM_PROVIDER_KEY_NAMES,
  type Db,
  type VmProviderCheckRow,
  type VmProviderKeyName,
} from "../db";
import { journalCaught } from "../journal";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest, readJson, sameToken } from "./handler";
import { KEYS, VM_PROVIDER_CHECK_BOUND_MS, type VmProviderCheckService } from "./runner-vm-keys";

export const VM_PROVIDERS_SETTINGS_PATH = "/api/settings/vm-providers";
export const VM_PROVIDERS_CHECK_PATH = "/api/settings/vm-providers/check";
export const VM_PROVIDER_CHECK_REUSE_MS = 30_000;

export type VmProvidersSettingsOptions = {
  home: string;
  configPath: string;
  store: Db;
  checks: VmProviderCheckService;
  csrfToken: string;
  trustedOrigin?: string;
  role?: string;
  audit: (action: string, subject: string) => Promise<void>;
  now?: () => number;
};

const KEY_FOR: Record<VmProviderKeyName, keyof typeof KEYS> = {
  "exe-dev": "exeDev",
  boat: "boat",
  instabox: "instabox",
  tailscale: "tailscale",
};

const isProviderKey = (name: unknown): name is VmProviderKeyName =>
  typeof name === "string" && (VM_PROVIDER_KEY_NAMES as readonly string[]).includes(name);
const isOffable = (name: unknown): name is MemberVmProviderName =>
  typeof name === "string" && (MEMBER_VM_PROVIDERS as readonly string[]).includes(name);

export async function handleVmProvidersSettingsRequest(
  request: Request,
  options: VmProvidersSettingsOptions,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== VM_PROVIDERS_SETTINGS_PATH && path !== VM_PROVIDERS_CHECK_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "VM providers are only available on the local Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can manage VM providers." }, 403);
  const now = options.now ?? Date.now;
  const allowed = path === VM_PROVIDERS_CHECK_PATH ? ["POST"] : ["GET", "PUT"];
  if (!allowed.includes(request.method)) return json({ error: "Method not allowed" }, 405);
  if (request.method === "GET") return status(options);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  const body = (await readJson(request).catch(() => null)) as Record<string, unknown> | null;
  if (request.method === "POST") {
    const key = body?.key;
    if (!isProviderKey(key)) return json({ error: "Name a VM provider key to check." }, 400);
    const stored = await options.store.run((q) => vmProviderCheckSteps(q, key));
    if (stored === null || now() - stored.checkedAt >= VM_PROVIDER_CHECK_REUSE_MS) {
      await options.checks.run(key, AbortSignal.timeout(VM_PROVIDER_CHECK_BOUND_MS));
      await options.audit("settings.vm_providers", `Checked the ${key} key`);
    }
    return status(options);
  }
  const provider = body?.provider;
  if (provider === "tailscale")
    return json({ error: "Tailscale can't be turned off: every provider needs it." }, 400);
  if (!isOffable(provider) || typeof body?.off !== "boolean")
    return json({ error: "Name a provider and whether it is off." }, 400);
  let size;
  try {
    size = loadConfigFile(options.configPath).memberVm ?? {};
  } catch (error) {
    journalCaught(error, "vm-providers.handleVmProvidersSettingsRequest.read", null);
    return json({ error: "Member VM settings could not be read" }, 503);
  }
  const others = (size.offProviders ?? []).filter((name) => name !== provider);
  const offProviders = body.off ? [...others, provider] : others;
  await writeMemberVmSize(options.configPath, { ...size, offProviders });
  await options.audit("settings.vm_providers", `Turned ${provider} ${body.off ? "off" : "on"}`);
  return status(options);
}

async function status(options: VmProvidersSettingsOptions): Promise<Response> {
  let off: MemberVmProviderName[];
  try {
    off = loadConfigFile(options.configPath).memberVm?.offProviders ?? [];
  } catch (error) {
    journalCaught(error, "vm-providers.status", null);
    return json({ error: "Member VM settings could not be read" }, 503);
  }
  const entries = await Promise.all(
    VM_PROVIDER_KEY_NAMES.map(async (name) => {
      const row = await options.store.run((q) => vmProviderCheckSteps(q, name));
      return [
        name,
        {
          set: KEYS[KEY_FOR[name]].status(options.home) === "readable",
          ...(isOffable(name) ? { off: off.includes(name) } : {}),
          check: row === null ? null : publicCheck(row),
        },
      ] as const;
    }),
  );
  return json({ ...Object.fromEntries(entries), nextCheckAt: await options.checks.nextCheckAt() });
}

function publicCheck({ state, message, facts, checkedAt, lastWorkingAt }: VmProviderCheckRow) {
  return { state, message, facts, checkedAt, lastWorkingAt };
}
