import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  BOAT_SIZES,
  loadConfigFile,
  parseBriefTemplates,
  readConfigText,
  updateVmSizes,
  useSettingsStore,
} from "../src/config";
import { savedSettingsText, sectionSettings, seedSettings } from "./saved-settings";
import { handleMemberVmSettingsRequest, type MemberVmSettingsOptions } from "../src/settings";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const SEEDED = '[vm_sizes]\noff_providers = ["boat"]\n\n[vm_sizes.exe-dev]\ncpu = 2\n';
const url = "http://127.0.0.1:8787/api/settings/vm-sizes";
const NO_KEY = { size: {}, note: "Save an InstaBox key to list sizes" };

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
  const instaBox: { sizes: [number, number][] | null } = { sizes: null };
  const options = (role?: string): MemberVmSettingsOptions => ({
    configPath,
    csrfToken: "csrf",
    ...(role ? { role } : {}),
    instaBoxSizes: async () => instaBox.sizes,
    audit: async (action, subject) => {
      audits.push(`${action}: ${subject}`);
    },
  });
  const read = async () =>
    (await handleMemberVmSettingsRequest(new Request(url), options()))!.json();
  const save = async (body: unknown, role = "admin") => {
    const response = (await handleMemberVmSettingsRequest(put(body), options(role)))!;
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { db, configPath, options, audits, instaBox, read, save };
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
    offProviders: ["boat"],
    providers: {
      "exe-dev": { size: { cpu: 2 }, limits: { cpu: 512, memoryGb: 4096, diskGb: 65_536 } },
      boat: { size: {}, allowed: BOAT_SIZES },
      instabox: NO_KEY,
    },
  });
  instaBox.sizes = [[4, 8]];
  expect(((await read()) as { providers: { instabox: unknown } }).providers.instabox).toEqual({
    size: {},
    allowed: [[4, 8]],
  });
});

test("a save changes only the providers it names and keeps the rest", async () => {
  const { configPath, audits, instaBox, save } = await instance();
  instaBox.sizes = [[8, 16]];
  const boat = { cpu: 4, memoryGb: 8 };
  const instabox = { cpu: 8, memoryGb: 16 };
  expect((await save({ provider: "boat", sizes: { boat } })).status).toBe(200);
  expect((await save({ sizes: { instabox } })).status).toBe(200);
  expect(loadConfigFile(configPath).vmSizes).toEqual({
    provider: "boat",
    offProviders: ["boat"],
    sizes: { "exe-dev": { cpu: 2 }, boat, instabox },
  });
  expect((await save({ sizes: { "exe-dev": {} }, offProviders: [] })).status).toBe(200);
  expect(loadConfigFile(configPath).vmSizes?.sizes?.["exe-dev"]).toBeUndefined();
  expect(audits[0]).toBe('settings.vm_sizes: Set VM sizes: boat {"cpu":4,"memoryGb":8}');
});

test("invalid values get 400 with a message and members get 403", async () => {
  const { db, options } = await instance();
  for (const [body, message] of [
    [{ sizes: { "exe-dev": { cpu: 0 } } }, "vm_sizes.cpu must be a whole number from 1 to 512"],
    [{ sizes: { "exe-dev": { pool: "-x" } } }, "vm_sizes.pool must be an exe.dev pool name"],
    [
      { sizes: { boat: { cpu: 6, memoryGb: 12 } } },
      "boat has no 6 vCPU / 12 GB size. Use 2/4, 4/8, 8/16 or 16/32.",
    ],
    [{ sizes: { boat: { diskGb: 2 } } }, "vm_sizes.boat has an unknown field: diskGb"],
    [{ sizes: { instabox: { cpu: 4, memoryGb: 8 } } }, "Save an InstaBox key to list sizes."],
    [[], "vm_sizes must be an object"],
  ] as const) {
    const response = await handleMemberVmSettingsRequest(put(body), options("admin"));
    expect(response!.status).toBe(400);
    const { error } = (await response!.json()) as { error: string };
    expect(error).toContain(message);
    expect(error).not.toContain("config.toml");
  }
  const member = await handleMemberVmSettingsRequest(put({}), options("member"));
  expect(member!.status).toBe(403);
  expect(await savedSettingsText(db)).toBe(SEEDED);
});

test("an InstaBox size is checked against the plan's sizes on every save", async () => {
  const { instaBox, save } = await instance();
  const body = { sizes: { instabox: { cpu: 4, memoryGb: 8 } } };
  instaBox.sizes = [[4, 8]];
  expect((await save(body)).status).toBe(200);
  instaBox.sizes = [[8, 16]];
  expect(await save(body)).toEqual({
    status: 400,
    body: { error: "InstaBox has no 4 vCPU / 8 GB size. Use 8/16." },
  });
});

test("a [member_vm] line inside a multiline brief template survives a save", async () => {
  const template = "Example:\n[member_vm]\ncpu = 4\n";
  const { configPath } = await instance(`${SEEDED}\n[brief]\ntemplate = """\n${template}"""\n`);
  await updateVmSizes(configPath, () => ({ sizes: { "exe-dev": { cpu: 6 } } }));
  const text = readConfigText(configPath);
  expect(parseBriefTemplates(text).template).toBe(template);
  expect(text).toContain("[vm_sizes.exe-dev]\ncpu = 6\n");
  expect(text).not.toContain("cpu = 2");
});
