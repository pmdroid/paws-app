import { removeSecret, saveSecret } from "../credentials";
import {
  exeDevTokenPath,
  exeDevTokenStatus,
  tailscaleAuthKeyPath,
  tailscaleAuthKeyStatus,
} from "../config";
import { isWorkspaceAdmin } from "../workspace";
import { json, localRequest, readJson, sameToken } from "./handler";

export const RUNNER_VM_KEYS_SETTINGS_PATH = "/api/settings/runner-vm-keys";

export type RunnerVmKeysSettingsOptions = {
  home: string;
  csrfToken: string;
  trustedOrigin?: string;
  role?: string;
  audit: (action: string, subject: string) => Promise<void>;
};

const KEYS = {
  exeDev: { path: exeDevTokenPath, status: exeDevTokenStatus, label: "exe.dev API token" },
  tailscale: {
    path: tailscaleAuthKeyPath,
    status: tailscaleAuthKeyStatus,
    label: "Tailscale auth key",
  },
} as const;
type KeyName = keyof typeof KEYS;
const isKey = (name: unknown): name is KeyName => name === "exeDev" || name === "tailscale";

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
  const status = () => json({ exeDev: set("exeDev"), tailscale: set("tailscale") });
  if (request.method === "GET") return status();
  if (request.method !== "PUT" && request.method !== "DELETE")
    return json({ error: "Method not allowed" }, 405);
  if (!sameToken(request.headers.get("x-paws-csrf"), options.csrfToken))
    return json({ error: "CSRF token missing" }, 403);
  if (request.method === "DELETE") {
    const name = url.searchParams.get("key");
    if (!isKey(name)) return json({ error: "Name a key to clear." }, 400);
    await removeSecret(KEYS[name].path(options.home));
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
    await options.audit("settings.runner_vm_keys", `Saved the ${KEYS[name].label}`);
  }
  return status();
}
