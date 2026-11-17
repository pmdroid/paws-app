import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  markRunnerAccountSignedIn,
  openRunnerAccountHome,
  publishRunnerAccountHome,
  runnerAccountBindings,
  type RunnerJob,
} from "../src/runner-execution";
import { runProviderLogin } from "../src/runner-login-worker";
import type { RunnerAccount, RunnerLoginUpdate } from "../src/runner-protocol";
import { executeRunnerCommand } from "../src/runner-worker";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

const a: RunnerAccount = {
  accountId: "01JACCOUNTA000000000000000",
  bindingId: "01JBINDINGA000000000000000",
};
const b: RunnerAccount = {
  accountId: "01JACCOUNTB000000000000000",
  bindingId: "01JBINDINGB000000000000000",
};

function seedCodex(root: string, account: RunnerAccount, token: string) {
  const home = openRunnerAccountHome(root, account, "codex", { signIn: true });
  publishRunnerAccountHome(home, "01J00000000000000000000009", () => {
    writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ token }));
    markRunnerAccountSignedIn(home, account, "codex");
  });
  return home;
}

async function signIn(root: string, account: RunnerAccount, token: string) {
  const home = openRunnerAccountHome(root, account, "opencode", { signIn: true });
  const provider = join(root, "opencode-provider.js");
  const seen = join(root, "provider-env.json");
  writeFileSync(
    provider,
    `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(process.env)); fs.mkdirSync(process.env.XDG_DATA_HOME + "/opencode", { recursive: true }); fs.writeFileSync(process.env.XDG_DATA_HOME + "/opencode/auth.json", ${JSON.stringify(JSON.stringify({ token }))}); process.exit(0);`,
  );
  const updates: RunnerLoginUpdate[] = [];
  await runProviderLogin({
    agent: "opencode",
    home,
    signal: AbortSignal.timeout(5000),
    command: [process.execPath, provider],
    emit: (update) => updates.push(update),
    async answer(_id, signal) {
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    },
    account: {
      publish: (write) =>
        publishRunnerAccountHome(home, "01J00000000000000000000009", () => {
          write();
          markRunnerAccountSignedIn(home, account, "opencode");
        }),
    },
  });
  const env = JSON.parse(readFileSync(seen, "utf8")) as NodeJS.ProcessEnv;
  rmSync(seen);
  return { home, state: updates.at(-1)?.state, env };
}

const auth = (home: string) => join(home, ".local", "share", "opencode", "auth.json");

test("signing in account B leaves account A's credentials and sessions untouched", async () => {
  const root = temporary("paws-two-accounts-");
  const first = await signIn(root, a, "synthetic-token-a");
  expect(first.state).toBe("connected");
  writeFileSync(join(first.home, ".local", "share", "opencode", "opencode.db"), "sessions");
  const second = await signIn(root, b, "synthetic-token-b");
  expect(second.state).toBe("connected");
  expect(second.env.HOME!.startsWith(join(second.home, ".paws-login-"))).toBe(true);
  expect(second.env.XDG_DATA_HOME).toBe(join(second.env.HOME!, ".local", "share"));

  expect(JSON.parse(readFileSync(auth(first.home), "utf8"))).toEqual({
    token: "synthetic-token-a",
  });
  expect(JSON.parse(readFileSync(auth(second.home), "utf8"))).toEqual({
    token: "synthetic-token-b",
  });
  expect(readdirSync(join(first.home, ".local", "share", "opencode")).sort()).toEqual([
    "auth.json",
    "opencode.db",
  ]);
  expect(readdirSync(join(second.home, ".local", "share", "opencode"))).toEqual(["auth.json"]);
  expect(runnerAccountBindings(root)).toEqual([
    { bindingId: a.bindingId, agent: "opencode" },
    { bindingId: b.bindingId, agent: "opencode" },
  ]);
  for (const home of [first.home, second.home])
    expect(readdirSync(home).filter((name) => name.startsWith(".paws-login-"))).toEqual([]);
}, 20_000);

test("Codex never signs in on the runner and publishes nothing", async () => {
  const root = temporary("paws-codex-account-");
  const home = openRunnerAccountHome(root, a, "codex", { signIn: true });
  const updates: RunnerLoginUpdate[] = [];
  await runProviderLogin({
    agent: "codex",
    home,
    signal: AbortSignal.timeout(5000),
    command: [process.execPath, "-e", "process.exit(0)"],
    emit: (update) => updates.push(update),
    answer: async () => ({ answer: "{}" }),
    account: {
      publish: () => {
        throw new Error("A Codex sign-in on the runner must not publish");
      },
    },
  });
  expect(updates.map((update) => update.state)).toEqual(["failed"]);
  expect(readdirSync(join(home, ".codex"))).toEqual(["sessions"]);
  expect(readdirSync(home).filter((name) => name.startsWith(".paws-login-"))).toEqual([]);
  expect(runnerAccountBindings(root)).toEqual([]);
});

test("a cancelled first sign-in leaves the binding unheld and writes nothing", async () => {
  const root = temporary("paws-cancelled-account-");
  const home = openRunnerAccountHome(root, a, "opencode", { signIn: true });
  const updates: RunnerLoginUpdate[] = [];
  const abort = new AbortController();
  const provider = join(root, "slow.js");
  writeFileSync(provider, "setInterval(() => {}, 1000);");
  const login = runProviderLogin({
    agent: "opencode",
    home,
    signal: abort.signal,
    command: [process.execPath, provider],
    emit: (update) => updates.push(update),
    answer: (_id, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
    account: {
      publish: () => {
        throw new Error("A cancelled sign-in must not publish");
      },
    },
  });
  setTimeout(() => abort.abort(), 100);
  await login;
  expect(updates.at(-1)!.state).toBe("failed");
  expect(existsSync(join(home, ".local", "share", "opencode"))).toBe(false);
  expect(runnerAccountBindings(root)).toEqual([]);
  expect(() => openRunnerAccountHome(root, a, "opencode")).toThrow(/not signed in/);
}, 20_000);

test("a credentials folder that links into another account fails the sign-in", async () => {
  const root = temporary("paws-linked-account-");
  const first = await signIn(root, a, "synthetic-token-a");
  const victim = auth(first.home);
  const home = openRunnerAccountHome(root, b, "opencode", { signIn: true });
  symlinkSync(
    join(first.home, ".local", "share", "opencode"),
    join(home, ".local", "share", "opencode"),
  );
  const provider = join(root, "provider.js");
  writeFileSync(
    provider,
    `const fs = require("node:fs"); fs.mkdirSync(process.env.XDG_DATA_HOME + "/opencode", { recursive: true }); fs.writeFileSync(process.env.XDG_DATA_HOME + "/opencode/auth.json", "{}"); process.exit(0);`,
  );
  const updates: RunnerLoginUpdate[] = [];
  await runProviderLogin({
    agent: "opencode",
    home,
    signal: AbortSignal.timeout(5000),
    command: [process.execPath, provider],
    emit: (update) => updates.push(update),
    answer: (_id, signal) =>
      new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
    account: {
      publish: (write) => publishRunnerAccountHome(home, "01J00000000000000000000009", write),
    },
  });
  expect(updates.at(-1)!.state).toBe("failed");
  expect(JSON.parse(readFileSync(victim, "utf8"))).toEqual({ token: "synthetic-token-a" });
}, 20_000);

let checks = 0;
async function check(root: string, account?: RunnerAccount, agent: "codex" | "claude" = "codex") {
  const outputDirectory = temporary("paws-account-output-");
  const work = join(root, "work");
  mkdirSync(work, { recursive: true });
  const script = join(outputDirectory, "..", `${Date.now()}-script.json`);
  writeFileSync(script, JSON.stringify({ model: "fixture-model", steps: [{ type: "hang" }] }));
  roots.push(script);
  const job: RunnerJob = {
    executionId: `01J0000000000000000000000${++checks}`,
    command: {
      id: "check",
      runnerId: "runner",
      workspaceId: "workspace",
      issuedAt: 1,
      expiresAt: Date.now() + 60_000,
      type: "login_check",
      agent,
      ...(account ? { account } : {}),
    },
  };
  const reads: NodeJS.ProcessEnv[] = [];
  const fake = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
  const result = await executeRunnerCommand({
    job,
    outputDirectory,
    workRoot: work,
    home: root,
    resultsGid: process.getgid!(),
    launch: {
      command: process.execPath,
      args: [fake, join(outputDirectory, "..", `${Date.now()}-trace.json`), script],
      env: {
        HOME: "/elsewhere",
        CODEX_HOME: "/elsewhere/.codex",
        XDG_DATA_HOME: "/elsewhere/share",
        XAI_API_KEY: "synthetic-xai-key",
      },
    },
    loginCommand: async (_command, _args, env) => {
      reads.push(env);
      return {
        exitCode: 0,
        stdout:
          agent === "claude"
            ? JSON.stringify({ loggedIn: true, authMethod: "oauth_token" })
            : "Logged in",
        stderr: "",
      };
    },
    claudeRateLimits: async () => null,
    codexRateLimits: async () => ({ rateLimits: {} }),
  });
  const files = readdirSync(outputDirectory).map((name) =>
    readFileSync(join(outputDirectory, name), "utf8"),
  );
  return { result, reads, files };
}

test("checks run with their binding's home and never see another account's secrets", async () => {
  const root = temporary("paws-account-check-");
  const home = seedCodex(root, a, "synthetic-token-a");
  seedCodex(root, b, "synthetic-token-b");
  const named = await check(root, a);
  expect(named.result.login?.authenticated).toBe(true);
  const env = named.reads[0]!;
  expect(env.HOME).toBe(home);
  expect(env.CODEX_HOME).toBe(join(home, ".codex"));
  expect(env.CLAUDE_CONFIG_DIR).toBe(join(home, ".claude"));
  expect(env.XDG_DATA_HOME).toBe(join(home, ".local", "share"));
  expect(env.XDG_CONFIG_HOME).toBe(join(home, ".config"));
  expect(env.XDG_STATE_HOME).toBe(join(home, ".local", "state"));
  expect(env.XDG_CACHE_HOME).toBe(join(home, ".cache"));
  expect(env.MISE_DATA_DIR).toBe(join(root, ".local", "share", "mise"));
  expect(env.XAI_API_KEY).toBeUndefined();
  const persisted = JSON.stringify([named.result, ...named.files]);
  for (const secret of ["synthetic-token-a", "synthetic-token-b", "synthetic-xai-key"])
    expect(persisted).not.toContain(secret);

  const legacy = await check(root);
  expect(legacy.reads[0]!.HOME).toBe(root);
  expect(legacy.reads[0]!.CODEX_HOME).toBe(join(root, ".codex"));
}, 30_000);

test("a named check for a binding this runner does not hold fails instead of using the default", async () => {
  const root = temporary("paws-account-missing-");
  writeFileSync(join(root, "marker"), "");
  mkdirSync(join(root, ".codex"));
  writeFileSync(join(root, ".codex", "auth.json"), JSON.stringify({ token: "synthetic-default" }));
  await expect(check(root, a)).rejects.toThrow(/not signed in/);
});

test("Claude token login checks receive the account credential", async () => {
  const root = temporary("paws-claude-check-");
  const home = openRunnerAccountHome(root, a, "claude", { signIn: true });
  markRunnerAccountSignedIn(home, a, "claude");
  writeFileSync(
    join(home, ".claude/paws-oauth.json"),
    JSON.stringify({
      kind: "oauth_token",
      token: "sk-ant-oat01-fixture",
      createdAt: 1,
      expiresAt: 9999999999999,
    }),
  );
  const checked = await check(root, a, "claude");
  expect(checked.reads[0]!.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-fixture");
  expect(checked.result.login?.authenticated).toBe(true);
});
