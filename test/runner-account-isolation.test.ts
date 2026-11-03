import { afterEach, expect, test } from "bun:test";
import {
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

const codexProvider = `
const input = require("node:readline").createInterface({ input: process.stdin });
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [{ id: "chat-gpt-device-code", name: "ChatGPT" }] } });
  else if (request.method === "authenticate") {
    require("node:fs").writeFileSync(process.env.CODEX_HOME + "/auth.json", JSON.stringify({ token: process.env.PAWS_FIXTURE_TOKEN ?? require("node:fs").readFileSync(process.env.HOME + "/../../token", "utf8") }));
    send({ id: request.id, result: {} });
  }
});
`;

async function signIn(
  root: string,
  account: RunnerAccount,
  token: string,
  agent: "codex" | "opencode" = "codex",
) {
  const home = openRunnerAccountHome(root, account, agent, { signIn: true });
  writeFileSync(join(root, ".paws-accounts", "token"), token);
  const provider = join(root, `${agent}-provider.js`);
  writeFileSync(
    provider,
    agent === "codex"
      ? codexProvider
      : `const fs = require("node:fs"); fs.mkdirSync(process.env.XDG_DATA_HOME + "/opencode", { recursive: true }); fs.writeFileSync(process.env.XDG_DATA_HOME + "/opencode/auth.json", ${JSON.stringify(JSON.stringify({ token }))}); process.exit(0);`,
  );
  const updates: RunnerLoginUpdate[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  await runProviderLogin({
    agent,
    home,
    signal: AbortSignal.timeout(5000),
    command: [process.execPath, provider],
    emit: (update) => updates.push(update),
    async answer(_id, signal) {
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    },
    async loginCommand(_command, _args, env) {
      envs.push(env);
      return { exitCode: 0, stdout: "Logged in", stderr: "" };
    },
    account: {
      publish: (write) =>
        publishRunnerAccountHome(home, "01J00000000000000000000009", () => {
          write();
          markRunnerAccountSignedIn(home, account, agent);
        }),
    },
  });
  rmSync(join(root, ".paws-accounts", "token"));
  return { home, state: updates.at(-1)?.state, envs };
}

test("signing in account B leaves account A's credentials and sessions untouched", async () => {
  const root = temporary("paws-two-accounts-");
  const first = await signIn(root, a, "synthetic-token-a");
  expect(first.state).toBe("connected");
  writeFileSync(join(first.home, ".codex", "sessions", "rollout-a.jsonl"), "{}\n");
  const second = await signIn(root, b, "synthetic-token-b");
  expect(second.state).toBe("connected");
  expect(second.envs[0]!.HOME!.startsWith(join(second.home, ".paws-login-"))).toBe(true);
  expect(second.envs[0]!.CODEX_HOME).toBe(join(second.envs[0]!.HOME!, ".codex"));
  expect(second.envs[0]!.XDG_DATA_HOME).toBe(join(second.envs[0]!.HOME!, ".local", "share"));

  expect(JSON.parse(readFileSync(join(first.home, ".codex", "auth.json"), "utf8"))).toEqual({
    token: "synthetic-token-a",
  });
  expect(JSON.parse(readFileSync(join(second.home, ".codex", "auth.json"), "utf8"))).toEqual({
    token: "synthetic-token-b",
  });
  expect(readdirSync(join(first.home, ".codex", "sessions"))).toEqual(["rollout-a.jsonl"]);
  expect(readdirSync(join(second.home, ".codex", "sessions"))).toEqual([]);
  expect(readdirSync(root).filter((name) => name.startsWith(".codex"))).toEqual([]);
  expect(runnerAccountBindings(root)).toEqual([
    { bindingId: a.bindingId, agent: "codex" },
    { bindingId: b.bindingId, agent: "codex" },
  ]);
  for (const home of [first.home, second.home])
    expect(readdirSync(home).filter((name) => name.startsWith(".paws-login-"))).toEqual([]);
}, 20_000);

test("a cancelled first sign-in leaves the binding unheld and writes nothing", async () => {
  const root = temporary("paws-cancelled-account-");
  const home = openRunnerAccountHome(root, a, "codex", { signIn: true });
  const updates: RunnerLoginUpdate[] = [];
  const abort = new AbortController();
  const provider = join(root, "slow.js");
  writeFileSync(provider, "setInterval(() => {}, 1000);");
  const login = runProviderLogin({
    agent: "codex",
    home,
    signal: abort.signal,
    command: [process.execPath, provider],
    emit: (update) => updates.push(update),
    answer: async () => ({ answer: "{}" }),
    account: {
      publish: () => {
        throw new Error("A cancelled sign-in must not publish");
      },
    },
  });
  setTimeout(() => abort.abort(), 100);
  await login;
  expect(updates.at(-1)!.state).toBe("failed");
  expect(readdirSync(join(home, ".codex"))).toEqual(["sessions"]);
  expect(runnerAccountBindings(root)).toEqual([]);
  expect(() => openRunnerAccountHome(root, a, "codex")).toThrow(/not signed in/);
}, 20_000);

test("an OpenCode account signs in through a staged XDG data folder", async () => {
  const root = temporary("paws-opencode-account-");
  const { home, state } = await signIn(root, a, "synthetic-opencode-token", "opencode");
  expect(state).toBe("connected");
  expect(
    JSON.parse(readFileSync(join(home, ".local", "share", "opencode", "auth.json"), "utf8")),
  ).toEqual({ token: "synthetic-opencode-token" });
  expect(runnerAccountBindings(root)).toEqual([{ bindingId: a.bindingId, agent: "opencode" }]);
}, 20_000);

test("a credentials folder that links into another account fails the sign-in", async () => {
  const root = temporary("paws-linked-account-");
  const first = await signIn(root, a, "synthetic-token-a");
  const victim = join(first.home, ".codex", "auth.json");
  const home = openRunnerAccountHome(root, b, "codex", { signIn: true });
  rmSync(join(home, ".codex"), { recursive: true });
  symlinkSync(join(first.home, ".codex"), join(home, ".codex"));
  const provider = join(root, "provider.js");
  writeFileSync(provider, codexProvider);
  const updates: RunnerLoginUpdate[] = [];
  await runProviderLogin({
    agent: "codex",
    home,
    signal: AbortSignal.timeout(5000),
    command: [process.execPath, provider],
    emit: (update) => updates.push(update),
    answer: async () => ({ answer: "{}" }),
    loginCommand: async () => ({ exitCode: 0, stdout: "Logged in", stderr: "" }),
    account: {
      publish: (write) => publishRunnerAccountHome(home, "01J00000000000000000000009", write),
    },
  });
  expect(updates.at(-1)!.state).toBe("failed");
  expect(JSON.parse(readFileSync(victim, "utf8"))).toEqual({ token: "synthetic-token-a" });
}, 20_000);

let checks = 0;
async function check(root: string, account?: RunnerAccount) {
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
      agent: "codex",
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
      return { exitCode: 0, stdout: "Logged in", stderr: "" };
    },
    codexRateLimits: async () => ({ rateLimits: {} }),
  });
  const files = readdirSync(outputDirectory).map((name) =>
    readFileSync(join(outputDirectory, name), "utf8"),
  );
  return { result, reads, files };
}

test("checks run with their binding's home and never see another account's secrets", async () => {
  const root = temporary("paws-account-check-");
  const { home } = await signIn(root, a, "synthetic-token-a");
  await signIn(root, b, "synthetic-token-b");
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
