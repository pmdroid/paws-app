import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  loadConfigFile,
  readConfigText,
  resolveLinearCommentAgents,
  useMemorySettings,
  useSettingsStore,
} from "../src/config";
import { CONFIG_SETTINGS_KEY, readSettingSteps, updateSettingSteps } from "../src/db";
import { handleLinearCommentSettingsRequest } from "../src/settings";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const url = "http://127.0.0.1:8787/api/settings/linear-comments";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function instance(withStore: boolean) {
  const home = tempHome();
  const configPath = join(home, "config.toml");
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  if (!withStore) {
    const settings = useMemorySettings(configPath, "");
    cleanups.push(() => settings.release());
  } else {
    const { db, close } = await tempStore();
    const settings = await useSettingsStore(configPath, {
      read: () => db.run((q) => readSettingSteps(q, CONFIG_SETTINGS_KEY)),
      update: (change) => db.transaction((q) => updateSettingSteps(q, CONFIG_SETTINGS_KEY, change)),
    });
    cleanups.push(close, () => settings.release());
  }
  return configPath;
}

function request(configPath: string, init?: RequestInit, role = "admin") {
  return handleLinearCommentSettingsRequest(new Request(url, init), {
    configPath,
    csrfToken: "csrf",
    role,
    audit: async () => {},
  });
}

function put(configPath: string, body: unknown, role = "admin") {
  return request(
    configPath,
    {
      method: "PUT",
      headers: { "content-type": "application/json", "x-paws-csrf": "csrf" },
      body: JSON.stringify(body),
    },
    role,
  );
}

const agents = (configPath: string) => resolveLinearCommentAgents(loadConfigFile(configPath));

test("while nothing is saved, GET and the reader return no agents", async () => {
  const configPath = await instance(true);
  expect(await (await request(configPath))!.json()).toEqual({
    agents: [],
    configured: false,
  });
  expect(agents(configPath)).toEqual([]);
});

test("a save goes to the database and applies without a restart", async () => {
  const configPath = await instance(true);
  const response = await put(configPath, { agents: ["saved-1", "saved-2", "saved-1"] });
  expect(response!.status).toBe(200);
  expect(await response!.json()).toEqual({ agents: ["saved-1", "saved-2"], configured: true });
  expect(agents(configPath)).toEqual(["saved-1", "saved-2"]);

  expect((await put(configPath, { agents: [] }))!.status).toBe(200);
  expect(agents(configPath)).toEqual([]);
});

test("with settings in memory the save is read back", async () => {
  const configPath = await instance(false);
  expect((await put(configPath, { agents: ["saved"] }))!.status).toBe(200);
  expect(readConfigText(configPath)).toContain('[linear_comments]\nagents = ["saved"]\n');
  expect(agents(configPath)).toEqual(["saved"]);
});

test("members get 403 and invalid values get 400 with a message", async () => {
  const configPath = await instance(true);
  expect((await put(configPath, { agents: ["x"] }, "member"))!.status).toBe(403);
  for (const body of [{ agents: ["bad id"] }, { agents: "x" }, { agents: [], extra: 1 }]) {
    const response = await put(configPath, body);
    expect(response!.status).toBe(400);
    expect(((await response!.json()) as { error: string }).error).toBeTruthy();
  }
  expect(agents(configPath)).toEqual([]);
});
