import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfigFile, overriddenConfigSections, useSettingsStore } from "../src/config";
import { CONFIG_SETTINGS_KEY, readSetting, readSettingSteps, updateSettingSteps } from "../src/db";
import { createMemberVmProvisioning } from "../src/member-vm";
import { createFakeExeDev } from "../src/provisioning";
import { handleMemberVmSettingsRequest, type MemberVmSettingsOptions } from "../src/settings";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const FILE = '[linear]\nteam = "ACME"\n\n[member_vm]\ncpu = 2\nimage = "ubuntu:24.04"\n';
const url = "http://127.0.0.1:8787/api/settings/member-vm";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function instance() {
  const { db, close } = await tempStore();
  const home = tempHome();
  const configPath = join(home, "config.toml");
  writeFileSync(configPath, FILE);
  const settings = await useSettingsStore(configPath, {
    read: () => db.run((q) => readSettingSteps(q, CONFIG_SETTINGS_KEY)),
    update: (change) => db.transaction((q) => updateSettingSteps(q, CONFIG_SETTINGS_KEY, change)),
  });
  cleanups.push(close, () => {
    settings.release();
    rmSync(home, { recursive: true, force: true });
  });
  const audits: string[] = [];
  const options = (role?: string): MemberVmSettingsOptions => ({
    configPath,
    csrfToken: "csrf",
    ...(role ? { role } : {}),
    audit: async (action, subject) => {
      audits.push(`${action}: ${subject}`);
    },
  });
  return { db, configPath, options, audits };
}

function put(body: unknown): Request {
  return new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-paws-csrf": "csrf" },
    body: JSON.stringify(body),
  });
}

test("GET reads the file until a save, then the database wins over later file edits", async () => {
  const { db, configPath, options, audits } = await instance();
  const read = async () =>
    (await handleMemberVmSettingsRequest(new Request(url), options()))!.json();
  expect(await read()).toEqual({ cpu: 2, image: "ubuntu:24.04" });

  const saved = { cpu: 8, memoryGb: 16, diskGb: 100, pool: "build" };
  const response = await handleMemberVmSettingsRequest(put(saved), options("admin"));
  expect(response!.status).toBe(200);
  expect(await response!.json()).toEqual(saved);
  expect(await readSetting(db, CONFIG_SETTINGS_KEY)).toContain("[member_vm]\ncpu = 8");
  expect(readFileSync(configPath, "utf8")).toBe(FILE);
  expect(audits).toEqual([
    "settings.member_vm: Set member VM size: cpu 8, memoryGb 16, diskGb 100, pool build",
  ]);

  writeFileSync(configPath, FILE.replace("cpu = 2", "cpu = 4"));
  expect(await read()).toEqual(saved);
  expect(loadConfigFile(configPath).memberVm).toEqual(saved);
  expect(overriddenConfigSections(configPath)).toEqual(["member_vm"]);
});

test("the next VM is created with the saved size", async () => {
  const { configPath, options } = await instance();
  const exeDev = createFakeExeDev();
  const provisioning = createMemberVmProvisioning({
    readToken: () => null,
    installer: () => null,
    publicUrl: "https://paws.example.invalid",
    runnerControl: async () => ({
      port: 8788,
      serverVersion: "1.4.0",
      mintEnrollment: () => ({ token: "t".repeat(43), expiresAt: 1 }),
    }),
    latestRelease: async () => null,
    exeDev,
    bootstrap: {} as never,
    size: () => loadConfigFile(configPath).memberVm ?? {},
  });
  expect((await provisioning()).size).toEqual({ cpu: 2, image: "ubuntu:24.04" });
  await handleMemberVmSettingsRequest(put({ cpu: 4, memoryGb: 8 }), options("admin"));
  expect((await provisioning()).size).toEqual({ cpu: 4, memoryGb: 8 });
});

test("invalid values get 400 with a message and members get 403", async () => {
  const { db, options } = await instance();
  for (const [body, message] of [
    [{ cpu: 0 }, "member_vm.cpu must be a whole number from 1 to 512"],
    [{ memoryGb: 1.5 }, "member_vm.memory_gb must be a whole number from 1 to 4096"],
    [{ image: "bad image" }, "member_vm.image must be an image name"],
    [{ pool: "-x" }, "member_vm.pool must be an exe.dev pool name"],
    [{ cores: 2 }, "member_vm has an unknown field: cores"],
    [[], "member_vm must be an object"],
  ] as const) {
    const response = await handleMemberVmSettingsRequest(put(body), options("admin"));
    expect(response!.status).toBe(400);
    expect(((await response!.json()) as { error: string }).error).toContain(message);
  }
  const member = await handleMemberVmSettingsRequest(put({ cpu: 4 }), options("member"));
  expect(member!.status).toBe(403);
  expect(await readSetting(db, CONFIG_SETTINGS_KEY)).toBe(null);
});
