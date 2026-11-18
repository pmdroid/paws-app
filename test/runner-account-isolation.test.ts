import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  markRunnerAccountSignedIn,
  openRunnerAccountHome,
  publishRunnerAccountHome,
  type RunnerJob,
} from "../src/runner-execution";
import type { RunnerAccount } from "../src/runner-protocol";
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
