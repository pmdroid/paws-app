import { removeSecret, saveSecret } from "../credentials";
import {
  boatTokenPath,
  exeDevTokenPath,
  instaboxTokenPath,
  vmProviderTokenStatus,
  exeDevTokenStatus,
  tailscaleAuthKeyPath,
  tailscaleAuthKeyStatus,
} from "../config";
import {
  deleteVmProviderCheckSteps,
  type Db,
  type VmProviderCheckRow,
  type VmProviderKeyName,
} from "../db";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest, readJson, sameToken } from "./handler";

export const RUNNER_VM_KEYS_SETTINGS_PATH = "/api/settings/runner-vm-keys";

export const VM_PROVIDER_CHECK_BOUND_MS = 10_000;

export type VmProviderCheckService = {
  run(name: VmProviderKeyName, signal?: AbortSignal): Promise<VmProviderCheckRow | null>;
  nextCheckAt(): Promise<number | null>;
};

export type RunnerVmKeysSettingsOptions = {
  home: string;
  csrfToken: string;
  trustedOrigin?: string;
  role?: string;
  store?: Db;
  audit: (action: string, subject: string) => Promise<void>;
  checks?: VmProviderCheckService;
};

export const KEYS = {
  exeDev: {
    path: exeDevTokenPath,
    status: exeDevTokenStatus,
    label: "exe.dev API token",
    check: "exe-dev",
  },
  tailscale: {
    path: tailscaleAuthKeyPath,
    status: tailscaleAuthKeyStatus,
    label: "Tailscale auth key",
    check: "tailscale",
  },
  boat: {
    path: boatTokenPath,
    status: (home: string) => vmProviderTokenStatus(home, "boat"),
    label: "boat API key",
    check: "boat",
  },
  instabox: {
    path: instaboxTokenPath,
    status: (home: string) => vmProviderTokenStatus(home, "instabox"),
    label: "InstaBox API key",
    check: "instabox",
  },
} as const;
type KeyName = keyof typeof KEYS;
const isKey = (name: unknown): name is KeyName =>
  typeof name === "string" && Object.hasOwn(KEYS, name);

export async function handleRunnerVmKeysSettingsRequest(
  request: Request,
  options: RunnerVmKeysSettingsOptions,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== RUNNER_VM_KEYS_SETTINGS_PATH) return null;
  if (!localRequest(request, options.trustedOrigin))
    return json({ error: "Runner VM keys are only available on the local Paws origin" }, 403);
  if (options.role !== undefined && !isWorkspaceAdmin(options.role))
    return json({ error: "Only workspace admins can manage runner VM keys." }, 403);
  const set = (name: KeyName) => KEYS[name].status(options.home) === "readable";
  const keys = () => ({
    exeDev: set("exeDev"),
    tailscale: set("tailscale"),
    boat: set("boat"),
    instabox: set("instabox"),
  });
  const status = () => json(keys());
  if (request.method === "GET") return status();
  if (request.method !== "PUT" && request.method !== "DELETE")
    return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  if (request.method === "DELETE") {
    const name = url.searchParams.get("key");
    if (!isKey(name)) return json({ error: "Name a key to clear." }, 400);
    await removeSecret(KEYS[name].path(options.home));
    if (name === "tailscale") await forgetTailnetJoin(options.store);
    await options.audit("settings.runner_vm_keys", `Cleared the ${KEYS[name].label}`);
    return status();
  }
  const body = (await readJson(request).catch(() => null)) as Record<string, unknown> | null;
  const values = Object.entries(body ?? {}).flatMap(([name, value]) =>
    isKey(name) && typeof value === "string" ? [[name, value.trim()] as const] : [],
  );
  if (values.length === 0 || values.some(([, value]) => !/^\S{1,4096}$/.test(value)))
    return json({ error: "Enter a key without spaces." }, 400);
  for (const [name, value] of values) {
    await saveSecret(KEYS[name].path(options.home), value);
    if (name === "tailscale") await forgetTailnetJoin(options.store);
    await options.audit("settings.runner_vm_keys", `Saved the ${KEYS[name].label}`);
  }
  if (options.checks === undefined) return status();
  let check: VmProviderCheckRow | null = null;
  for (const [name] of values)
    check = await options.checks.run(
      KEYS[name].check,
      AbortSignal.timeout(VM_PROVIDER_CHECK_BOUND_MS),
    );
  return json({ ...keys(), check });
}

async function forgetTailnetJoin(store: Db | undefined): Promise<void> {
  await store?.run((q) => deleteVmProviderCheckSteps(q, "tailscale"));
}
