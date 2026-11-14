import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeoutPolicyRoot, loadConfigFile, useSettingsStore } from "../src/config";
import { handleCloseoutSettingsRequest, type CloseoutSettingsOptions } from "../src/settings";

let dir: string;
let configPath: string;
let policies: string;
let audits: string[];
let stored: string | null;
let release: () => void;

const FILE =
  '[merge]\norder = "queue"\n\n[closeout.projects."acme/one"]\npolicy_root = "/from/file"\n';

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "paws-closeout-settings-"));
  configPath = join(dir, "config.toml");
  policies = join(dir, "policies");
  mkdirSync(policies);
  writeFileSync(configPath, FILE);
  audits = [];
  stored = null;
  const snapshot = await useSettingsStore(configPath, {
    read: async () => stored,
    update: async (change) => {
      stored = change(stored);
    },
  });
  release = snapshot.release;
});

afterEach(() => {
  release();
  rmSync(dir, { recursive: true, force: true });
});

function options(role?: string): CloseoutSettingsOptions {
  return {
    configPath,
    csrfToken: "csrf",
    ...(role ? { role } : {}),
    audit: async (action) => {
      audits.push(action);
    },
  };
}

const url = "http://127.0.0.1:8787/api/settings/closeout";
function put(body: unknown): Request {
  return new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-paws-csrf": "csrf" },
    body: JSON.stringify(body),
  });
}

const liveRoot = () => closeoutPolicyRoot(loadConfigFile(configPath), dir, "Acme/One");

test("GET reads the file until a save, then the database wins over later file edits", async () => {
  const before = await handleCloseoutSettingsRequest(new Request(url), options());
  expect(await before!.json()).toEqual({ projects: { "acme/one": { policyRoot: "/from/file" } } });

  const body = { projects: { "Acme/One": { policyRoot: policies } } };
  const saved = await handleCloseoutSettingsRequest(put(body), options("admin"));
  expect(saved!.status).toBe(200);
  expect(await saved!.json()).toEqual({ projects: { "acme/one": { policyRoot: policies } } });
  expect(stored).toContain(`[closeout.projects."acme/one"]\npolicy_root = "${policies}"`);
  expect(readFileSync(configPath, "utf8")).toBe(FILE);
  expect(liveRoot()).toBe(policies);
  expect(audits).toEqual(["settings.closeout"]);

  writeFileSync(configPath, FILE.replace("/from/file", "/edited/file"));
  expect(liveRoot()).toBe(policies);
  const after = await handleCloseoutSettingsRequest(new Request(url), options());
  expect(await after!.json()).toEqual({ projects: { "acme/one": { policyRoot: policies } } });
});

test("a relative, missing or non-directory policyRoot is a 400 with a message", async () => {
  const file = join(dir, "file.txt");
  writeFileSync(file, "x");
  for (const policyRoot of ["policies", join(dir, "missing"), file]) {
    const response = await handleCloseoutSettingsRequest(
      put({ projects: { "acme/one": { policyRoot } } }),
      options("admin"),
    );
    expect(response!.status).toBe(400);
    expect(((await response!.json()) as { error: string }).error).toContain("policyRoot");
  }
  const badRepo = await handleCloseoutSettingsRequest(
    put({ projects: { acme: { policyRoot: policies } } }),
    options("admin"),
  );
  expect(badRepo!.status).toBe(400);
  expect(stored).toBeNull();
});

test("only workspace admins can save", async () => {
  const body = { projects: { "acme/one": { policyRoot: policies } } };
  expect((await handleCloseoutSettingsRequest(put(body), options("member")))!.status).toBe(403);
  expect(stored).toBeNull();
  expect(liveRoot()).toBe("/from/file");
});
