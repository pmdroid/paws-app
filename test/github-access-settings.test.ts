import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentReadAllowed,
  githubMirrorsOn,
  loadConfigFile,
  useActiveGitHubMirrors,
  useSettingsStore,
} from "../src/config";
import { setJournalSink } from "../src/journal";
import {
  handleGitHubAccessSettingsRequest,
  type GitHubAccessSettingsOptions,
} from "../src/settings";

let dir: string;
let configPath: string;
let audits: string[];
let stored: string | null;
let release: () => void;
const SEEDED = "[github]\nmirrors = true\n";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "paws-github-access-"));
  configPath = join(dir, "config.toml");
  audits = [];
  stored = SEEDED;
  const snapshot = await useSettingsStore(configPath, {
    read: async () => stored,
    update: async (change) => {
      stored = change(stored);
    },
  });
  release = () => snapshot.release();
});

afterEach(() => {
  useActiveGitHubMirrors(undefined);
  release();
  rmSync(dir, { recursive: true, force: true });
});

function options(role?: string): GitHubAccessSettingsOptions {
  return {
    configPath,
    csrfToken: "csrf",
    ...(role ? { role } : {}),
    audit: async (action) => {
      audits.push(action);
    },
  };
}

const url = "http://127.0.0.1:8787/api/settings/github-access";
function put(body: unknown, csrf = "csrf"): Request {
  return new Request(url, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-paws-csrf": csrf },
    body: JSON.stringify(body),
  });
}

test("without a saved section the settings come from the [github] keys", async () => {
  const response = await handleGitHubAccessSettingsRequest(new Request(url), options());
  expect(await response!.json()).toEqual({
    configured: false,
    agentRead: true,
    mirrors: true,
  });
  expect(agentReadAllowed(loadConfigFile(configPath))).toBe(true);
});

test("a save goes to the database, wins over [github] mirrors and applies without a restart", async () => {
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    const response = await handleGitHubAccessSettingsRequest(
      put({ agentRead: false, mirrors: false }),
      options("admin"),
    );
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({
      configured: true,
      agentRead: false,
      mirrors: false,
      restartRequired: true,
    });
  } finally {
    restore();
  }
  expect(stored).toBe("[github_access]\nagent_read = false\nmirrors = false\n");
  expect(lines.some((line) => line.includes("mirrors set to false"))).toBe(true);
  expect(audits).toEqual(["settings.github_access"]);
  const config = loadConfigFile(configPath);
  expect(agentReadAllowed(config)).toBe(false);
  expect(githubMirrorsOn(config)).toBe(false);
  const again = await handleGitHubAccessSettingsRequest(
    put({ agentRead: true, mirrors: false }),
    options("admin"),
  );
  expect(await again!.json()).toMatchObject({ agentRead: true, restartRequired: false });
  expect(agentReadAllowed(loadConfigFile(configPath))).toBe(true);
});

test("a member, a missing CSRF token or an invalid value cannot write", async () => {
  const body = { agentRead: false, mirrors: true };
  expect((await handleGitHubAccessSettingsRequest(put(body), options("member")))!.status).toBe(403);
  expect((await handleGitHubAccessSettingsRequest(put(body, "wrong"), options()))!.status).toBe(
    403,
  );
  const invalid = await handleGitHubAccessSettingsRequest(
    put({ agentRead: "no", mirrors: true }),
    options(),
  );
  expect(invalid!.status).toBe(400);
  expect(((await invalid!.json()) as { error: string }).error).toContain("githubAccess.agentRead");
  expect(stored).toBe(SEEDED);
});

test("restartRequired compares the save with the reader Paws started with", async () => {
  useActiveGitHubMirrors(true);
  const off = await handleGitHubAccessSettingsRequest(
    put({ agentRead: true, mirrors: false }),
    options("admin"),
  );
  expect(await off!.json()).toMatchObject({ restartRequired: true });
  const again = await handleGitHubAccessSettingsRequest(
    put({ agentRead: false, mirrors: false }),
    options("admin"),
  );
  expect(await again!.json()).toMatchObject({ restartRequired: true });
  const back = await handleGitHubAccessSettingsRequest(
    put({ agentRead: false, mirrors: true }),
    options("admin"),
  );
  expect(await back!.json()).toMatchObject({ restartRequired: false });
});
