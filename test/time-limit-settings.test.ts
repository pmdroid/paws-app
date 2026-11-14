import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  copyCapsToTimeLimits,
  journalRetiredProjectSettings,
  loadConfigFile,
  resolveTimeLimits,
  useSettingsStore,
} from "../src/config";
import { handleTimeLimitSettingsRequest, type TimeLimitSettingsOptions } from "../src/settings";

let dir: string;
let configPath: string;
let audits: [string, string][];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "paws-time-limits-"));
  configPath = join(dir, "config.toml");
  writeFileSync(configPath, '[caps]\nmax_awake_ms = 5400000\n\n[merge]\norder = "queue"\n');
  audits = [];
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

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

test("without [time_limits] the settings ignore [caps] and show the default implementation limit", async () => {
  const response = await handleTimeLimitSettingsRequest(new Request(url), options());
  expect(await response!.json()).toEqual({
    configured: false,
    default: { implementationMinutes: 180, fixesMinutes: 0, closeoutMinutes: 0 },
  });
});

test("a [caps] value above the maximum is saved as the maximum and journaled as shortened", async () => {
  writeFileSync(configPath, `[caps]\nmax_awake_ms = ${8 * 24 * 60 * 60_000}\n`);
  const line = await copyCapsToTimeLimits(configPath, loadConfigFile(configPath));
  expect(line).toContain("implementation_minutes = 10080 (shortened from 11520 minutes");
  expect(resolveTimeLimits(loadConfigFile(configPath), 1).implementation).toBe(10_080 * 60_000);
});

test("startup copies [caps] max_awake_ms into the saved time limits once", async () => {
  writeFileSync(
    configPath,
    "[caps]\nmax_awake_ms = 5410000\n\n[time_limits]\nfixes_minutes = 30\n",
  );
  let stored: string | null = null;
  const snapshot = await useSettingsStore(configPath, {
    read: async () => stored,
    update: async (change) => {
      stored = change(stored);
    },
  });
  try {
    const line = await copyCapsToTimeLimits(configPath, loadConfigFile(configPath));
    expect(line).toContain("implementation_minutes = 91");
    expect(stored!).toContain("[time_limits]\nimplementation_minutes = 91\nfixes_minutes = 30\n");
    expect(readFileSync(configPath, "utf8")).not.toContain("implementation_minutes");
    writeFileSync(configPath, "[caps]\nmax_awake_ms = 60000\n\n[time_limits]\nfixes_minutes = 5\n");
    expect(await copyCapsToTimeLimits(configPath, loadConfigFile(configPath))).toBeNull();
    expect(resolveTimeLimits(loadConfigFile(configPath), 1)).toEqual({
      implementation: 91 * 60_000,
      fixes: 30 * 60_000,
      closeout: 0,
    });
    const response = await handleTimeLimitSettingsRequest(new Request(url), options());
    expect(await response!.json()).toEqual({
      configured: true,
      default: { implementationMinutes: 91, fixesMinutes: 30, closeoutMinutes: 0 },
    });
    const body = { default: { implementationMinutes: 45, fixesMinutes: 0, closeoutMinutes: 0 } };
    expect((await handleTimeLimitSettingsRequest(put(body), options("admin")))!.status).toBe(200);
    writeFileSync(configPath, "[time_limits]\nimplementation_minutes = 7\n");
    expect(resolveTimeLimits(loadConfigFile(configPath), 1).implementation).toBe(45 * 60_000);
  } finally {
    snapshot.release();
  }
});

test("a write replaces [time_limits] and keeps every other table", async () => {
  const body = {
    default: { implementationMinutes: 180, fixesMinutes: 60, closeoutMinutes: 0 },
  };
  const response = await handleTimeLimitSettingsRequest(put(body), options("admin"));
  expect(response!.status).toBe(200);
  expect(await response!.json()).toEqual({ configured: true, ...body });
  const text = readFileSync(configPath, "utf8");
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
  expect(readFileSync(configPath, "utf8")).not.toContain("time_limits");
});

test("an old project table loads, is ignored and journals once; the next save drops it", async () => {
  writeFileSync(
    configPath,
    '[time_limits]\nimplementation_minutes = 60\n\n[time_limits.projects."proj-1"]\nimplementation_minutes = 5\n',
  );
  const response = await handleTimeLimitSettingsRequest(new Request(url), options());
  expect(await response!.json()).toEqual({
    configured: true,
    default: { implementationMinutes: 60, fixesMinutes: 0, closeoutMinutes: 0 },
  });
  expect(resolveTimeLimits(loadConfigFile(configPath), 1).implementation).toBe(60 * 60_000);
  const lines: string[] = [];
  journalRetiredProjectSettings(configPath, (line) => lines.push(line));
  expect(lines).toEqual([
    "time_limits.projects is no longer supported; using the global time limits",
  ]);
  const body = { default: { implementationMinutes: 60, fixesMinutes: 0, closeoutMinutes: 0 } };
  expect((await handleTimeLimitSettingsRequest(put(body), options("admin")))!.status).toBe(200);
  expect(readFileSync(configPath, "utf8")).not.toContain("projects");
});
