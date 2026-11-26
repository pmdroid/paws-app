import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfigFile,
  parseBriefTemplates,
  readConfigText,
  useSettingsStore,
  writeMemberVmSize,
} from "../src/config";
import { savedSettingsText, sectionSettings, seedSettings } from "./saved-settings";
import { createMemberVmProvisioning } from "../src/member-vm";
import { handleMemberVmSettingsRequest, type MemberVmSettingsOptions } from "../src/settings";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const SEEDED = '[member_vm]\ncpu = 2\nimage = "ubuntu:24.04"\n';
const url = "http://127.0.0.1:8787/api/settings/member-vm";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function instance(seeded = SEEDED) {
  const { db, close } = await tempStore();
  const home = tempHome();
  const configPath = join(home, "config.toml");
  await seedSettings(db, seeded);
  const settings = await useSettingsStore(configPath, sectionSettings(db));
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
  const read = async () =>
    (await handleMemberVmSettingsRequest(new Request(url), options()))!.json();
  return { db, configPath, options, audits, read };
}

function put(body: unknown): Request {
  return new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-paws-csrf": "csrf" },
    body: JSON.stringify(body),
  });
}

test("GET reads the saved size and a save replaces it", async () => {
  const { db, options, audits, read } = await instance();
  expect(await read()).toEqual({ cpu: 2, image: "ubuntu:24.04" });

  const saved = { cpu: 8, memoryGb: 16, diskGb: 100, pool: "build" };
  const response = await handleMemberVmSettingsRequest(put(saved), options("admin"));
  expect(response!.status).toBe(200);
  expect(await response!.json()).toEqual(saved);
  expect(await savedSettingsText(db)).toContain("[member_vm]\ncpu = 8");
  expect(audits).toEqual([
    "settings.member_vm: Set member VM size: cpu 8, memoryGb 16, diskGb 100, pool build",
  ]);
  expect(await read()).toEqual(saved);
});

test("saving the size keeps the providers that are turned off", async () => {
  const { options, read } = await instance('[member_vm]\ncpu = 2\noff_providers = ["boat"]\n');
  expect(await read()).toEqual({ cpu: 2, offProviders: ["boat"] });
  await handleMemberVmSettingsRequest(put({ cpu: 4 }), options("admin"));
  expect(await read()).toEqual({ cpu: 4, offProviders: ["boat"] });
  await handleMemberVmSettingsRequest(put({ cpu: 4, offProviders: [] }), options("admin"));
  expect(await read()).toEqual({ cpu: 4 });
});

test("the next VM is created with the saved size", async () => {
  const { configPath, options } = await instance();
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
    bootstrap: {} as never,
    size: () => loadConfigFile(configPath).memberVm ?? {},
  });
  expect((await provisioning("exe-dev")).size).toEqual({ cpu: 2, image: "ubuntu:24.04" });
  await handleMemberVmSettingsRequest(put({ cpu: 4, memoryGb: 8 }), options("admin"));
  expect((await provisioning("exe-dev")).size).toEqual({ cpu: 4, memoryGb: 8 });
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
    const { error } = (await response!.json()) as { error: string };
    expect(error).toContain(message);
    expect(error).not.toContain("config.toml");
  }
  const member = await handleMemberVmSettingsRequest(put({ cpu: 4 }), options("member"));
  expect(member!.status).toBe(403);
  expect(await savedSettingsText(db)).toBe(SEEDED);
});

test("boat takes only its own sizes and no pool, image or disk", async () => {
  const { configPath, options, read } = await instance();
  const save = (body: unknown) => handleMemberVmSettingsRequest(put(body), options("admin"));
  for (const [body, message] of [
    [
      { provider: "boat", cpu: 6, memoryGb: 12 },
      "boat has no 6 vCPU / 12 GB size. Use 2/4, 4/8, 8/16 or 16/32.",
    ],
    [{ provider: "boat", cpu: 6 }, "boat has no 6 vCPU size without memory_gb."],
    [{ provider: "boat", pool: "build" }, "boat has no pool setting."],
    [{ provider: "boat", diskGb: 20 }, "boat has no disk_gb setting."],
    [{ provider: "instabox", image: "ubuntu:24.04" }, "InstaBox has no image setting."],
    [{ provider: "instabox", diskGb: 2048 }, "InstaBox has no 2048 GB data disk. Use 1 to 1024."],
    [{ provider: "aws" }, "member_vm.provider must be exe-dev, boat or instabox"],
  ] as const) {
    const response = await save(body);
    expect(response!.status).toBe(400);
    expect(((await response!.json()) as { error: string }).error).toContain(message);
  }
  expect(await read()).toEqual({ cpu: 2, image: "ubuntu:24.04" });
  expect((await save({ provider: "boat", cpu: 8, memoryGb: 16 }))!.status).toBe(200);
  expect(loadConfigFile(configPath).memberVm).toEqual({ provider: "boat", cpu: 8, memoryGb: 16 });
  const insta = { provider: "instabox", cpu: 32, memoryGb: 64, diskGb: 1024 };
  expect((await save(insta))!.status).toBe(200);
  expect(await read()).toEqual(insta);
});

test("a saved empty size resets the defaults", async () => {
  const { db, configPath, options, read } = await instance();
  expect((await handleMemberVmSettingsRequest(put({}), options("admin")))!.status).toBe(200);
  expect(await savedSettingsText(db)).not.toMatch(/cpu|memory|disk/);
  expect(await read()).toEqual({});
  expect(loadConfigFile(configPath).memberVm ?? {}).toEqual({});
});

test("a [member_vm] line inside a multiline brief template survives a save", async () => {
  const template = "Example:\n[member_vm]\ncpu = 4\n";
  const { configPath } = await instance(`${SEEDED}\n[brief]\ntemplate = """\n${template}"""\n`);
  await writeMemberVmSize(configPath, { cpu: 6 });
  const text = readConfigText(configPath);
  expect(parseBriefTemplates(text).template).toBe(template);
  expect(text).toContain("[member_vm]\ncpu = 6\n");
  expect(text).not.toContain("cpu = 2");
});
