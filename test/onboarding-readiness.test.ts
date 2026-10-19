import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loginGitHub, type GitHubTokenStore, type StoredGitHubOAuth } from "../src/auth";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function isolated() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "paws-onboarding-")));
  roots.push(root);
  const home = join(root, "home");
  const kyoto = join(home, ".kyotoagent");
  const bin = join(root, "bin");
  mkdirSync(kyoto, { recursive: true });
  mkdirSync(bin);
  expect(realpathSync(home)).toBe(home);
  expect(realpathSync(kyoto)).toBe(kyoto);
  return {
    root,
    bin,
    env: {
      HOME: home,
      KYOTOAGENT_ROOT: kyoto,
      PAWS_HOME: join(home, ".paws"),
      PAWS_GITHUB_CLIENT_ID: "Iv1.onboarding-fixture",
      PATH: bin,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/no-secret-service`,
    },
  };
}

async function launch(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, "--no-env-file", ...args], {
    cwd: resolve(import.meta.dir, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  console.log(JSON.stringify({ args, code, stdout, stderr }));
  return { code, stdout, stderr };
}

function memoryStore() {
  let saved: StoredGitHubOAuth | null = null;
  let invalidated = false;
  const store: GitHubTokenStore = {
    backend: "file",
    warning: null,
    load: async () => saved,
    save: async (token) => {
      saved = token;
    },
    async update(change) {
      const next = change(saved);
      if (next === null) return false;
      saved = next;
      return true;
    },
    markInvalid: async () => {
      invalidated = true;
    },
    delete: async () => {
      saved = null;
    },
  };
  return { store, invalidated: () => invalidated };
}

describe("standalone GitHub login readiness (#54)", () => {
  for (const browser of ["headless", "failed"]) {
    test(`production CLI announces the code before polling with ${browser} browser`, async () => {
      const scene = isolated();
      const result = await launch(
        ["--preload", "./test/fixtures/onboarding-login.ts", "src/index.ts", "login", "github"],
        { ...scene.env, PAWS_TEST_BROWSER: browser },
      );
      expect(result.code).toBe(0);
      expect(result.stdout.split("\n").slice(0, 2)).toEqual([
        "Enter code LOCAL-CODE at https://github.com/login/device",
        "Signed in as local-user",
      ]);
      const events = result.stderr
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; value?: string });
      const announced = events.findIndex(
        (event) => event.event === "output" && event.value?.includes("LOCAL-CODE"),
      );
      expect(announced).toBeGreaterThanOrEqual(0);
      expect(announced).toBeLessThan(events.findIndex((event) => event.event === "browser"));
      expect(announced).toBeLessThan(events.findIndex((event) => event.event === "poll-sleep"));
      expect(events.some((event) => event.event === "save" && event.value === "local-user")).toBe(
        true,
      );
    });
  }

  test("injected output also precedes browser and polling after device-code expiry", async () => {
    const events: string[] = [];
    const { store } = memoryStore();
    let codes = 0;
    let polls = 0;
    await loginGitHub({
      oauthClientId: "Iv1.onboarding-fixture",
      store,
      stdout: (line) => {
        events.push(line);
      },
      openBrowser: async () => {
        events.push("browser");
        throw new Error("No browser available");
      },
      sleep: async () => {
        events.push("sleep");
      },
      fetch: async (url) => {
        if (url.endsWith("/device/code"))
          return Response.json({
            device_code: `device-${++codes}`,
            user_code: `CODE-${codes}`,
            verification_uri: "https://github.com/login/device",
            interval: 1,
            expires_in: 900,
          });
        if (url.endsWith("/access_token"))
          return Response.json(
            ++polls === 1
              ? { error: "expired_token" }
              : { access_token: "fixture-access", scope: "repo read:org" },
          );
        if (url.endsWith("/user"))
          return Response.json(
            { login: "local-user", id: 7 },
            { headers: { "x-oauth-scopes": "repo, read:org" } },
          );
        throw new Error(`Unexpected network request: ${url}`);
      },
    });
    expect(events).toEqual([
      "Enter code CODE-1 at https://github.com/login/device",
      "browser",
      "sleep",
      "Enter code CODE-2 at https://github.com/login/device",
      "browser",
      "sleep",
      "Signed in as local-user",
    ]);
  });
});
