import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loginGitHub, type GitHubTokenStore, type StoredGitHubOAuth } from "../src/auth";
import { chooseGitHubRepo } from "../src/setup/github";
import { createIO } from "../src/setup/io";
import { detectCandidates, selectImplementer } from "../src/setup";

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

describe("setup login executable detection (#56)", () => {
  for (const implementer of ["claude", "codex"] as const) {
    for (const native of [false, true]) {
      test(`${implementer} adapter with native CLI ${native} agrees with doctor`, async () => {
        const scene = isolated();
        for (const [bin, output] of [
          ["bun", "1.4.2"],
          ["git", "git version 2.40.0"],
        ]) {
          const path = join(scene.bin, bin!);
          writeFileSync(path, `#!/bin/sh\necho '${output}'\n`);
          chmodSync(path, 0o700);
        }
        const adapter = implementer === "claude" ? "claude-agent-acp" : "codex-acp";
        writeFileSync(join(scene.bin, adapter), "exit 0\n");
        chmodSync(join(scene.bin, adapter), 0o700);
        if (native) {
          writeFileSync(
            join(scene.bin, implementer),
            `#!/bin/sh\nprintf '%s\\n' "$*" >> '${scene.root}/commands'\nexit 0\n`,
          );
          chmodSync(join(scene.bin, implementer), 0o700);
        }
        const result = await launch(["test/fixtures/onboarding-readiness.ts"], {
          ...scene.env,
          PAWS_TEST_IMPLEMENTER: implementer,
        });
        expect(result.code).toBe(0);
        const observed = JSON.parse(result.stdout) as {
          candidates: {
            id: string;
            installed: boolean;
            loginable: boolean;
            loginCommand: string;
          }[];
          output: string[];
          selected: { id: string } | null;
          checks: { name: string; ok: boolean }[];
        };
        expect(observed.candidates.find((item) => item.id === implementer)).toMatchObject({
          installed: true,
          loginable: native,
        });
        expect(observed.selected?.id ?? null).toBe(native ? implementer : null);
        expect(observed.checks.find((item) => item.name === implementer)?.ok).toBe(native);
        if (native) {
          expect(observed.output.join("")).toContain(
            `Run \`${implementer === "claude" ? "claude auth login" : "codex login"}\``,
          );
          const commands = readFileSync(join(scene.root, "commands"), "utf8").trim().split("\n");
          expect(commands.length).toBeGreaterThanOrEqual(2);
          expect(new Set(commands)).toEqual(
            new Set([implementer === "claude" ? "auth status" : "login status"]),
          );
        } else expect(observed.output.join("")).not.toContain(`${implementer}: Run`);
      });
    }
  }

  test("Grok execution readiness is separate from the advertised login command", async () => {
    const scene = isolated();
    const packageRoot = join(scene.root, "package");
    const platform = join(
      packageRoot,
      "node_modules",
      "@xai-official",
      `grok-${process.platform}-${process.arch}`,
    );
    mkdirSync(join(packageRoot, "node_modules", ".bin"), { recursive: true });
    mkdirSync(platform, { recursive: true });
    writeFileSync(join(packageRoot, "node_modules", ".bin", "grok"), "");
    for (const loginable of [false, true]) {
      const candidates = detectCandidates({
        packageRoot,
        which: (bin) => (loginable && bin === "grok" ? "/fake/grok" : null),
      });
      expect(candidates.find((item) => item.id === "grok")).toMatchObject({
        installed: true,
        loginable,
        loginCommand: "grok login",
      });
      const selected = await selectImplementer({ candidates, choice: "grok", write: () => {} });
      expect(selected?.id ?? null).toBe(loginable ? "grok" : null);
    }
  });

  test("custom adapter executables do not substitute for native login CLIs", async () => {
    const candidates = detectCandidates({
      env: {
        PAWS_CLAUDE_ACP: "/fake/claude-adapter --verbose",
        PAWS_CODEX_ACP: "/fake/codex-adapter",
      },
      which: (bin) => (bin.startsWith("/fake/") ? bin : null),
      packageRoot: "/not-installed",
    });
    expect(
      candidates
        .filter((item) => item.id !== "grok")
        .map((item) => [item.installed, item.loginable]),
    ).toEqual([
      [true, false],
      [true, false],
    ]);
    expect(await selectImplementer({ candidates, choice: "claude", write: () => {} })).toBeNull();
  });
});

describe("GitHub repository filtering (#58)", () => {
  function repo(name: string, push = true) {
    return { full_name: name, permissions: { push } };
  }

  test("filters all pages before limiting the displayed pushable matches", async () => {
    const lines = ["target", "1"];
    const output: string[] = [];
    const fetched: string[] = [];
    const result = await chooseGitHubRepo({
      token: "fixture-access",
      repo: null,
      yes: false,
      store: memoryStore().store,
      io: createIO({
        stdout: (line) => {
          output.push(line);
        },
        readLine: async () => lines.shift() ?? null,
        fetch: async (url) => {
          fetched.push(url);
          if (url.endsWith("page=2"))
            return Response.json([
              repo("acme/target-denied", false),
              ...Array.from({ length: 35 }, (_, index) => repo(`acme/target-${index}`)),
            ]);
          return Response.json(
            Array.from({ length: 100 }, (_, index) => repo(`acme/recent-${index}`)),
            { headers: { link: '<https://api.github.com/user/repos?page=2>; rel="next"' } },
          );
        },
      }),
    });
    console.log(JSON.stringify({ result, fetched, output }));
    expect(result).toEqual({ owner: "acme", repo: "target-0" });
    expect(fetched).toHaveLength(2);
    expect(output.filter((line) => /^  \d+\)/.test(line))).toHaveLength(30);
    expect(output.join("\n")).not.toContain("target-denied");
    expect(output.join("\n")).not.toContain("target-30");
  });

  test("empty filter shows only the newest 30 pushable repositories", async () => {
    const lines = ["", "30"];
    const output: string[] = [];
    const result = await chooseGitHubRepo({
      token: "fixture-access",
      repo: null,
      yes: false,
      store: memoryStore().store,
      io: createIO({
        stdout: (line) => {
          output.push(line);
        },
        readLine: async () => lines.shift() ?? null,
        fetch: async () =>
          Response.json([
            repo("acme/denied", false),
            ...Array.from({ length: 40 }, (_, index) => repo(`acme/repo-${index}`)),
          ]),
      }),
    });
    expect(result.repo).toBe("repo-29");
    expect(output.filter((line) => /^  \d+\)/.test(line))).toHaveLength(30);
  });

  test("a later repository can be filtered and chosen by owner/name", async () => {
    const lines = ["REPO-30", "ACME/REPO-30"];
    const result = await chooseGitHubRepo({
      token: "fixture-access",
      repo: null,
      yes: false,
      store: memoryStore().store,
      io: createIO({
        stdout: () => {},
        readLine: async () => lines.shift() ?? null,
        fetch: async () =>
          Response.json(Array.from({ length: 31 }, (_, index) => repo(`acme/repo-${index}`))),
      }),
    });
    expect(result).toEqual({ owner: "acme", repo: "repo-30" });
  });

  for (const status of [200, 401]) {
    test(`explicit owner/name keeps push validation and invalidation (status ${status})`, async () => {
      const { store, invalidated } = memoryStore();
      const fetched: string[] = [];
      const io = createIO({
        fetch: async (url) => {
          fetched.push(url);
          return Response.json({ permissions: { push: false } }, { status });
        },
      });
      await expect(
        chooseGitHubRepo({ token: "fixture-access", repo: "acme/later", yes: true, io, store }),
      ).rejects.toThrow(status === 401 ? "login github" : "cannot push");
      expect(fetched).toEqual(["https://api.github.com/repos/acme/later"]);
      expect(invalidated()).toBe(status === 401);
    });
  }

  test("explicit owner/name selects repositories without listing", async () => {
    const fetched: string[] = [];
    const result = await chooseGitHubRepo({
      token: "fixture-access",
      repo: "acme/later.git",
      yes: true,
      store: memoryStore().store,
      io: createIO({
        fetch: async (url) => {
          fetched.push(url);
          return Response.json({ permissions: { push: true } });
        },
      }),
    });
    expect(result).toEqual({ owner: "acme", repo: "later" });
    expect(fetched).toEqual(["https://api.github.com/repos/acme/later"]);
  });
});
