import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfigFile,
  readConfigText,
  resolveTimeLimits,
  useMemorySettings,
} from "../src/config";
import { handleTimeLimitSettingsRequest, type TimeLimitSettingsOptions } from "../src/settings";

let dir: string;
let configPath: string;
let audits: [string, string][];
let release: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "paws-time-limits-"));
  configPath = join(dir, "config.toml");
  release = useMemorySettings(configPath, '[merge]\norder = "queue"\n').release;
  audits = [];
});

afterEach(() => {
  release();
  rmSync(dir, { recursive: true, force: true });
});

function options(role?: string): TimeLimitSettingsOptions {
  return {
    configPath,
    csrfToken: "csrf",
    ...(role ? { role } : {}),
    audit: async (action, subject) => {
      audits.push([action, subject]);
    },
  };
}

const url = "http://127.0.0.1:8787/api/settings/time-limits";
function put(body: unknown, csrf = "csrf"): Request {
  return new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-paws-csrf": csrf },
    body: JSON.stringify(body),
  });
}

test("without [time_limits] the settings show the default implementation limit", async () => {
  const response = await handleTimeLimitSettingsRequest(new Request(url), options());
  expect(await response!.json()).toEqual({
    configured: false,
    default: { implementationMinutes: 180, fixesMinutes: 0, closeoutMinutes: 0 },
  });
});

test("a write replaces [time_limits] and keeps every other table", async () => {
  const body = {
    default: { implementationMinutes: 180, fixesMinutes: 60, closeoutMinutes: 0 },
  };
  const response = await handleTimeLimitSettingsRequest(put(body), options("admin"));
  expect(response!.status).toBe(200);
  expect(await response!.json()).toEqual({ configured: true, ...body });
  const text = readConfigText(configPath);
  expect(text).toContain('[merge]\norder = "queue"');
  expect(text).toContain(
    "[time_limits]\nimplementation_minutes = 180\nfixes_minutes = 60\ncloseout_minutes = 0\n",
  );
  expect(text).not.toContain("projects");
  expect(resolveTimeLimits(loadConfigFile(configPath), 1)).toEqual({
    implementation: 180 * 60_000,
    fixes: 60 * 60_000,
    closeout: 0,
  });
  expect(audits.map(([action]) => action)).toEqual(["settings.time_limits"]);
});

test("a member, a missing CSRF token or an invalid limit cannot write", async () => {
  const body = {
    default: { implementationMinutes: 180, fixesMinutes: 0, closeoutMinutes: 0 },
  };
  expect((await handleTimeLimitSettingsRequest(put(body), options("member")))!.status).toBe(403);
  expect((await handleTimeLimitSettingsRequest(put(body, "wrong"), options()))!.status).toBe(403);
  const invalid = { ...body, default: { ...body.default, fixesMinutes: -1 } };
  expect((await handleTimeLimitSettingsRequest(put(invalid), options()))!.status).toBe(400);
  expect(readConfigText(configPath)).not.toContain("time_limits");
});
