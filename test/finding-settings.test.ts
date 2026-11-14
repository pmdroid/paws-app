import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFile, useSettingsStore } from "../src/config";
import {
  CONFIG_SETTINGS_KEY,
  findingGroupingEnabled,
  readSetting,
  readSettingSteps,
  updateSettingSteps,
  type Db,
} from "../src/db";
import { handleFindingSettingsRequest, type FindingSettingsOptions } from "../src/settings";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

let db: Db;
let close: () => Promise<void>;
let audits: [string, string][];
let dir: string;
let configPath: string;
let release: () => void;

beforeEach(async () => {
  ({ db, close } = await tempStore());
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "ws", linearOrganizationId: "org", name: "Workspace", createdAt: 1 }),
  );
  audits = [];
  dir = mkdtempSync(join(tmpdir(), "paws-finding-settings-"));
  configPath = join(dir, "config.toml");
  writeFileSync(configPath, '[findings]\ngrouping_time = "07:30"\n');
  ({ release } = await useSettingsStore(configPath, {
    read: () => db.run((q) => readSettingSteps(q, CONFIG_SETTINGS_KEY)),
    update: (change) => db.transaction((q) => updateSettingSteps(q, CONFIG_SETTINGS_KEY, change)),
  }));
});

afterEach(async () => {
  release();
  rmSync(dir, { recursive: true, force: true });
  await close();
});

function options(role?: string): FindingSettingsOptions {
  return {
    store: db,
    csrfToken: "csrf",
    workspaceId: "ws",
    configPath,
    ...(role ? { role } : {}),
    audit: async (action, subject) => {
      audits.push([action, subject]);
    },
  };
}

const url = "http://127.0.0.1:8787/api/settings/findings";
function post(body: unknown, csrf = "csrf", method = "POST"): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", "x-paws-csrf": csrf },
    body: JSON.stringify(body),
  });
}

test("grouping starts on and an admin can switch it off and on", async () => {
  const listed = await handleFindingSettingsRequest(new Request(url), options("admin"));
  expect(await listed!.json()).toEqual({ grouping: true, groupingTime: "07:30" });
  const off = await handleFindingSettingsRequest(post({ grouping: false }), options("admin"));
  expect(off!.status).toBe(200);
  expect(await off!.json()).toMatchObject({ grouping: false });
  expect(await findingGroupingEnabled(db, "ws")).toBe(false);
  await handleFindingSettingsRequest(post({ grouping: true }), options("admin"));
  expect(await findingGroupingEnabled(db, "ws")).toBe(true);
  expect(audits).toEqual([
    ["settings.findings.grouping", "Turned daily finding grouping off"],
    ["settings.findings.grouping", "Turned daily finding grouping on"],
  ]);
});

test("members, missing CSRF and malformed bodies cannot change grouping", async () => {
  expect(
    (await handleFindingSettingsRequest(post({ grouping: false }), options("member")))!.status,
  ).toBe(403);
  expect(
    (await handleFindingSettingsRequest(post({ grouping: false }, "wrong"), options("admin")))!
      .status,
  ).toBe(403);
  expect(
    (await handleFindingSettingsRequest(post({ grouping: "no" }), options("admin")))!.status,
  ).toBe(400);
  expect(await findingGroupingEnabled(db, "ws")).toBe(true);
  expect(audits).toEqual([]);
});

test("an admin saves the grouping time to the database and the file no longer applies", async () => {
  const saved = await handleFindingSettingsRequest(
    post({ groupingTime: "21:15" }, "csrf", "PUT"),
    options("admin"),
  );
  expect(saved!.status).toBe(200);
  expect(await saved!.json()).toEqual({ grouping: true, groupingTime: "21:15" });
  expect(await readSetting(db, CONFIG_SETTINGS_KEY)).toContain('grouping_time = "21:15"');
  writeFileSync(configPath, '[findings]\ngrouping_time = "03:00"\n');
  expect(loadConfigFile(configPath).findingsGroupingTime).toBe("21:15");
  const listed = await handleFindingSettingsRequest(new Request(url), options("admin"));
  expect(await listed!.json()).toEqual({ grouping: true, groupingTime: "21:15" });
  expect(audits).toEqual([
    ["settings.findings.grouping_time", "Set daily finding grouping time to 21:15 UTC"],
  ]);
});

test("members and invalid times cannot change the grouping time", async () => {
  expect(
    (await handleFindingSettingsRequest(
      post({ groupingTime: "08:00" }, "csrf", "PUT"),
      options("member"),
    ))!.status,
  ).toBe(403);
  for (const groupingTime of ["24:00", "7:30", "07:60", 730]) {
    const response = await handleFindingSettingsRequest(
      post({ groupingTime }, "csrf", "PUT"),
      options("admin"),
    );
    expect(response!.status).toBe(400);
    expect(await response!.json()).toEqual({
      error: "Send groupingTime as HH:MM (24-hour, UTC).",
    });
  }
  expect(await readSetting(db, CONFIG_SETTINGS_KEY)).toBeNull();
  expect(readFileSync(configPath, "utf8")).toContain('"07:30"');
  expect(audits).toEqual([]);
});
