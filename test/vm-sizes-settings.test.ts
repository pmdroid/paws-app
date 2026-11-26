import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfigFile,
  parseBriefTemplates,
  readConfigText,
  useSettingsStore,
  writeVmSizes,
  type VmSizeChoice,
} from "../src/config";
import { savedSettingsText, sectionSettings, seedSettings } from "./saved-settings";
import { handleVmSizesSettingsRequest, type VmSizesSettingsOptions } from "../src/settings";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const SEEDED = '[vm_sizes.exe-dev]\ncpu = 2\nimage = "ubuntu:24.04"\n';
const url = "http://127.0.0.1:8787/api/settings/vm-sizes";
const BOAT_SIZES = [
  { cpu: 2, memoryGb: 4 },
  { cpu: 4, memoryGb: 8 },
  { cpu: 8, memoryGb: 16 },
  { cpu: 16, memoryGb: 32 },
];

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
  const instaBox: { sizes: VmSizeChoice[] | null } = { sizes: null };
  const options = (role = "admin"): VmSizesSettingsOptions => ({
    configPath,
    csrfToken: "csrf",
    role,
    instaBoxSizes: async () => instaBox.sizes,
    audit: async (action, subject) => {
      audits.push(`${action}: ${subject}`);
    },
  });
  const read = async () =>
    (await handleVmSizesSettingsRequest(new Request(url), options()))!.json();
  const save = async (body: unknown, role?: string) => {
    const response = (await handleVmSizesSettingsRequest(put(body), options(role)))!;
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { db, configPath, audits, instaBox, read, save };
}

function put(body: unknown): Request {
  return new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-paws-csrf": "csrf" },
    body: JSON.stringify(body),
  });
}

test("GET returns each provider's saved size and its allowed sizes", async () => {
  const { instaBox, read } = await instance();
  expect(await read()).toEqual({
    providers: {
      "exe-dev": {
        size: { cpu: 2, image: "ubuntu:24.04" },
        limits: { cpu: 512, memoryGb: 4096, diskGb: 65_536 },
      },
      boat: { size: {}, allowed: BOAT_SIZES },
      instabox: { size: {}, note: "Save an InstaBox key to list sizes" },
    },
  });
  instaBox.sizes = [{ cpu: 4, memoryGb: 8 }];
  expect(((await read()) as { providers: { instabox: unknown } }).providers.instabox).toEqual({
    size: {},
    allowed: [{ cpu: 4, memoryGb: 8 }],
  });
});

test("each provider keeps its own size, and a save keeps the providers turned off", async () => {
  const { db, configPath, audits, instaBox, save } = await instance(
    `${SEEDED}\n[vm_sizes]\noff_providers = ["boat"]\n`,
  );
  instaBox.sizes = [
    { cpu: 4, memoryGb: 8 },
    { cpu: 8, memoryGb: 16 },
  ];
  const sizes = {
    "exe-dev": { cpu: 8, memoryGb: 16, diskGb: 100, pool: "build" },
    boat: { cpu: 4, memoryGb: 8 },
    instabox: { cpu: 8, memoryGb: 16 },
  };
  const saved = await save({ provider: "boat", sizes });
  expect(saved.status).toBe(200);
  expect(loadConfigFile(configPath).vmSizes).toEqual({
    provider: "boat",
    offProviders: ["boat"],
    sizes,
  });
  expect(await savedSettingsText(db)).toContain("[vm_sizes.boat]\ncpu = 4\nmemory_gb = 8\n");
  expect(audits).toEqual([
    "settings.vm_sizes: Set VM sizes: exe-dev cpu 8 memoryGb 16 diskGb 100 pool build, boat cpu 4 memoryGb 8, instabox cpu 8 memoryGb 16",
  ]);
  instaBox.sizes = null;
  expect((await save({ sizes: { instabox: sizes.instabox }, offProviders: [] })).status).toBe(200);
  expect(loadConfigFile(configPath).vmSizes).toEqual({ sizes: { instabox: sizes.instabox } });
});

test("an invalid boat or InstaBox size is refused with the allowed list", async () => {
  const { db, instaBox, save } = await instance();
  const refused = async (body: unknown, message: string) => {
    const response = await save(body);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe(message);
  };
  await refused(
    { sizes: { boat: { cpu: 6, memoryGb: 12 } } },
    "boat has no 6 vCPU / 12 GB size. Use 2/4, 4/8, 8/16 or 16/32.",
  );
  await refused(
    { sizes: { boat: { cpu: 6 } } },
    "boat has no 6 vCPU size without memory_gb. Use 2/4, 4/8, 8/16 or 16/32.",
  );
  await refused(
    { sizes: { instabox: { cpu: 4, memoryGb: 8 } } },
    "Save an InstaBox key to list sizes.",
  );
  instaBox.sizes = [{ cpu: 4, memoryGb: 8 }];
  await refused(
    { sizes: { instabox: { cpu: 8, memoryGb: 16 } } },
    "InstaBox has no 8 vCPU / 16 GB size. Use 4/8.",
  );
  await refused(
    { sizes: { "exe-dev": { cpu: 0 } } },
    "vm_sizes.exe-dev.cpu must be a whole number from 1 to 512",
  );
  await refused(
    { sizes: { aws: {} } },
    "vm_sizes.sizes has an unknown field: aws (use exe-dev, boat, instabox)",
  );
  await refused({ provider: "aws" }, "vm_sizes.provider must be exe-dev, boat or instabox");
  await refused([], "vm_sizes must be an object");
  expect((await save({ sizes: { boat: { cpu: 8 } } }, "member")).status).toBe(403);
  expect(await savedSettingsText(db)).toBe(SEEDED);
});

test("a saved empty body resets every provider to its default", async () => {
  const { db, read, save } = await instance();
  expect((await save({})).status).toBe(200);
  expect(await savedSettingsText(db)).not.toMatch(/cpu|memory|disk/);
  expect(((await read()) as { providers: { "exe-dev": unknown } }).providers["exe-dev"]).toEqual({
    size: {},
    limits: { cpu: 512, memoryGb: 4096, diskGb: 65_536 },
  });
});

test("a [vm_sizes] line inside a multiline brief template survives a save", async () => {
  const template = "Example:\n[vm_sizes.boat]\ncpu = 4\n";
  const { configPath } = await instance(`${SEEDED}\n[brief]\ntemplate = """\n${template}"""\n`);
  await writeVmSizes(configPath, { sizes: { boat: { cpu: 2, memoryGb: 4 } } });
  const text = readConfigText(configPath);
  expect(parseBriefTemplates(text).template).toBe(template);
  expect(text).toContain("[vm_sizes.boat]\ncpu = 2\nmemory_gb = 4\n");
  expect(text).not.toContain("image");
});
