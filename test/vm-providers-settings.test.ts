import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { loadSettings, useSettingsStore } from "../src/config";
import { failMemberVmStep, insertMemberVm } from "../src/db";
import { sectionSettings } from "./saved-settings";
import { createFakeExeDev } from "../src/provisioning";
import {
  handleRunnerVmKeysSettingsRequest,
  handleVmProvidersSettingsRequest,
  type VmProviderCheckService,
} from "../src/settings";
import { createVmProviderChecks, exeDevKeyCheck } from "../src/vm-provider-checks";
import { tempHome } from "./helpers";
import { withoutForeignKeys } from "./pglite-fixtures";
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
  const configPath = home;
  const settings = await useSettingsStore(configPath, sectionSettings(db));
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
  const providers = async (request: Request, role = "admin", workspaceId?: string) =>
    (await handleVmProvidersSettingsRequest(request, {
      ...common(role),
      home: configPath,
      store: db,
      ...(workspaceId === undefined ? {} : { workspaceId }),
      now: () => clock,
    }))!;
  const keys = async (request: Request, role = "admin") =>
    (await handleRunnerVmKeysSettingsRequest(request, common(role)))!;
  return { db, configPath, exe, audits, providers, keys, tick: (ms: number) => (clock += ms) };
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
  expect(loadSettings(configPath).vmSizes?.offProviders).toEqual(["boat"]);
  const tailscale = await providers(
    send("PUT", "/vm-providers", { provider: "tailscale", off: true }),
  );
  expect(tailscale.status).toBe(400);
  await providers(send("PUT", "/vm-providers", { provider: "boat", off: false }));
  expect(loadSettings(configPath).vmSizes?.offProviders).toBeUndefined();
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

test("overlapping checks of one key call the provider once", async () => {
  const { exe, providers, keys, tick } = await instance();
  await keys(send("PUT", "/runner-vm-keys", { exeDev: "exe-token-1" }));
  tick(60_000);
  const check = () => providers(send("POST", "/vm-providers/check", { key: "exe-dev" }));
  const answers = await Promise.all([check(), check(), check()]);
  expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200]);
  expect(exe.calls).toHaveLength(2);
});

test("overlapping toggles of different providers both stay saved", async () => {
  const { configPath, providers } = await instance();
  await Promise.all([
    providers(send("PUT", "/vm-providers", { provider: "boat", off: true })),
    providers(send("PUT", "/vm-providers", { provider: "instabox", off: true })),
  ]);
  expect(loadSettings(configPath).vmSizes?.offProviders?.toSorted()).toEqual(["boat", "instabox"]);
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

test("GET with a workspace lists each provider's runner VMs, whatever Create VM's key", async () => {
  const { db, providers } = await instance();
  await withoutForeignKeys(db);
  for (const [id, workspaceId, provider] of [
    ["vm-1", "w1", "boat"],
    ["vm-2", "w1", "exe-dev"],
    ["vm-3", "w2", "boat"],
  ] as const)
    await insertMemberVm(db, {
      id,
      workspaceId,
      userId: "u1",
      vmName: id,
      pool: null,
      provider,
      now: 1,
    });
  await failMemberVmStep(db, { id: "vm-2", step: "create", failure: "exe.dev refused", now: 2 });
  const response = await providers(new Request(`${base}/vm-providers`), "admin", "w1");
  const body = (await response.json()) as Record<string, { vms?: unknown }>;
  expect(body.boat!.vms).toEqual([
    { vmName: "vm-1", runnerId: null, step: "create", failure: null },
  ]);
  expect(body["exe-dev"]!.vms).toEqual([
    { vmName: "vm-2", runnerId: null, step: "failed", failure: "exe.dev refused" },
  ]);
  expect(body.instabox!.vms).toEqual([]);
  expect(body.tailscale!.vms).toBeUndefined();
});
