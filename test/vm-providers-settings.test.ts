import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfigFile, useSettingsStore } from "../src/config";
import { CONFIG_SETTINGS_KEY, readSettingSteps, updateSettingSteps } from "../src/db";
import { createFakeExeDev } from "../src/provisioning";
import {
  handleRunnerVmKeysSettingsRequest,
  handleVmProvidersSettingsRequest,
  type VmProviderCheckService,
} from "../src/settings";
import { createVmProviderChecks, exeDevKeyCheck } from "../src/vm-provider-checks";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const base = "http://127.0.0.1:8787/api/settings";
const headers = { "content-type": "application/json", "x-paws-csrf": "csrf" };
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function instance() {
  const { db, close } = await tempStore();
  const home = tempHome();
  const configPath = join(home, "config.toml");
  const settings = await useSettingsStore(configPath, {
    read: () => db.run((q) => readSettingSteps(q, CONFIG_SETTINGS_KEY)),
    update: (change) => db.transaction((q) => updateSettingSteps(q, CONFIG_SETTINGS_KEY, change)),
  });
  cleanups.push(close, () => {
    settings.release();
    rmSync(home, { recursive: true, force: true });
  });
  const exe = createFakeExeDev();
  let clock = 1_000_000;
  const vmChecks = createVmProviderChecks({
    db,
    home,
    checks: { "exe-dev": exeDevKeyCheck(exe) },
    now: () => clock,
  });
  const checks: VmProviderCheckService = {
    run: (name, signal) => vmChecks.runVmProviderCheck(name, signal),
    nextCheckAt: async () => 5_000_000,
  };
  const audits: string[] = [];
  const common = (role: string) => ({
    home,
    csrfToken: "csrf",
    role,
    checks,
    audit: async (_action: string, subject: string) => {
      audits.push(subject);
    },
  });
  const providers = async (request: Request, role = "admin") =>
    (await handleVmProvidersSettingsRequest(request, {
      ...common(role),
      configPath,
      store: db,
      now: () => clock,
    }))!;
  const keys = async (request: Request, role = "admin") =>
    (await handleRunnerVmKeysSettingsRequest(request, common(role)))!;
  return { configPath, exe, audits, providers, keys, tick: (ms: number) => (clock += ms) };
}

const send = (method: string, path: string, body: unknown, withCsrf = true) =>
  new Request(`${base}${path}`, {
    method,
    headers: withCsrf ? headers : { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("GET lists each provider, PUT turns boat off and on, and tailscale can't be turned off", async () => {
  const { configPath, audits, providers } = await instance();
  const empty = { set: false, off: false, check: null };
  expect(await (await providers(new Request(`${base}/vm-providers`))).json()).toEqual({
    "exe-dev": empty,
    boat: empty,
    instabox: empty,
    tailscale: { set: false, check: null },
    nextCheckAt: 5_000_000,
  });
  expect(
    (await providers(send("PUT", "/vm-providers", { provider: "boat", off: true }))).status,
  ).toBe(200);
  const listed = (await (await providers(new Request(`${base}/vm-providers`))).json()) as Record<
    string,
    { off?: boolean }
  >;
  expect(listed.boat?.off).toBe(true);
  expect(listed["exe-dev"]?.off).toBe(false);
  expect(loadConfigFile(configPath).memberVm?.offProviders).toEqual(["boat"]);
  const tailscale = await providers(
    send("PUT", "/vm-providers", { provider: "tailscale", off: true }),
  );
  expect(tailscale.status).toBe(400);
  await providers(send("PUT", "/vm-providers", { provider: "boat", off: false }));
  expect(loadConfigFile(configPath).memberVm?.offProviders).toBeUndefined();
  expect(audits).toEqual(["Turned boat off", "Turned boat on"]);
});

test("a non-admin gets 403, and PUT or POST without a CSRF token gets 403", async () => {
  const { providers } = await instance();
  expect((await providers(new Request(`${base}/vm-providers`), "member")).status).toBe(403);
  const off = { provider: "boat", off: true };
  expect((await providers(send("PUT", "/vm-providers", off), "member")).status).toBe(403);
  expect((await providers(send("PUT", "/vm-providers", off, false))).status).toBe(403);
  const check = { key: "exe-dev" };
  expect((await providers(send("POST", "/vm-providers/check", check, false))).status).toBe(403);
});

test("two checks within 30 s call the provider once, and a later one calls it again", async () => {
  const { exe, audits, providers, keys, tick } = await instance();
  await keys(send("PUT", "/runner-vm-keys", { exeDev: "exe-token-1" }));
  tick(60_000);
  const check = () => providers(send("POST", "/vm-providers/check", { key: "exe-dev" }));
  const first = (await (await check()).json()) as Record<string, unknown>;
  expect(first["exe-dev"]).toMatchObject({ set: true, check: { state: "working" } });
  expect(exe.calls).toHaveLength(2);
  tick(29_000);
  await check();
  expect(exe.calls).toHaveLength(2);
  tick(1_000);
  await check();
  expect(exe.calls).toHaveLength(3);
  expect(audits.filter((line) => line.startsWith("Checked"))).toEqual([
    "Checked the exe-dev key",
    "Checked the exe-dev key",
  ]);
});

test("saving a key returns its check result beside the set flags", async () => {
  const { exe, keys } = await instance();
  const saved = await (
    await keys(send("PUT", "/runner-vm-keys", { exeDev: "exe-token-1" }))
  ).json();
  expect(saved).toMatchObject({
    exeDev: true,
    tailscale: false,
    check: { name: "exe-dev", state: "working", message: "exe.dev accepted the key." },
  });
  expect(exe.calls).toHaveLength(1);
});
