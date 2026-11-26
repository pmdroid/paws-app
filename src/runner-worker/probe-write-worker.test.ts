import { afterEach, expect, test } from "bun:test";
import { helperSandboxStarts } from "../../test/helper-sandbox";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerAccountHome } from "../runner-execution";
import { runnerHelperLifetime, type RunnerCommand } from "../runner-protocol";
import { executeRunnerCommand } from ".";
import { signInRunnerAccount } from "../../test/runner-account-home";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sandbox = helperSandboxStarts;
const account = {
  accountId: "01JACCOUNTA000000000000000",
  bindingId: "01JBINDINGA000000000000000",
};
const executionId = "01J00000000000000000000001";
const now = Date.now();
const command: Extract<RunnerCommand, { type: "helper" }> = {
  id: randomUUID(),
  type: "helper",
  runnerId: "runner",
  workspaceId: "workspace",
  issuedAt: now,
  expiresAt: now + runnerHelperLifetime("probe_write"),
  sessionId: "probes-write",
  sessionGeneration: 0,
  purpose: "probe_write",
  profile: { agent: "codex", model: "fixture-model" },
  prompt: "Distill these sources.",
  account,
  probe: { repository: "acme/web", path: ".agents/probes/no-raw-sql.ts" },
};

test.skipIf(!sandbox)(
  "a probe_write turn at origin/main writes only its probe and returns it with its rules entry",
  async () => {
    const root = mkdtempSync(join(homedir(), ".paws-probe-write-"));
    roots.push(root);
    const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args: string[]) =>
      execFileSync("git", args, { encoding: "utf8", env: gitEnv }).trim();
    const origin = join(root, "origin");
    mkdirSync(origin);
    git("-C", origin, "init", "-q", "-b", "main");
    writeFileSync(join(origin, "README.md"), "web\n");
    git("-C", origin, "add", ".");
    git(
      "-C",
      origin,
      "-c",
      "user.name=Paws",
      "-c",
      "user.email=paws@example.com",
      "commit",
      "-qm",
      "init",
    );
    const bundle = join(root, "probe.bundle");
    git("-C", origin, "bundle", "create", "-q", bundle, "refs/heads/main");
    const agentHome = join(root, "agent");
    mkdirSync(agentHome, { mode: 0o700 });
    signInRunnerAccount(agentHome, "codex", account);
    const sessions = join(runnerAccountHome(agentHome, account), ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    const worktree = join(root, "work", executionId);
    const probe = join(worktree, ".agents", "probes", "no-raw-sql.ts");
    const script = join(root, "script.json");
    writeFileSync(
      script,
      JSON.stringify({
        model: "fixture-model",
        steps: [
          { type: "fs_write", path: probe, content: "export {};\n" },
          { type: "fs_write", path: join(worktree, "note.txt"), content: "x" },
          {
            type: "update",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: '```json\n{"paths":["src/**"],"failOn":"P1"}\n```' },
            },
          },
          { type: "end" },
        ],
      }),
    );
    mkdirSync(join(root, "output"));
    const result = await executeRunnerCommand({
      job: {
        executionId,
        command,
      },
      repositoryBundle: bundle,
      outputDirectory: join(root, "output"),
      workRoot: join(root, "work"),
      home: agentHome,
      resultsGid: process.getgid!(),
      launch: {
        command: process.execPath,
        args: [
          "--no-env-file",
          fileURLToPath(new URL("../acp/testing/fake-agent.ts", import.meta.url)),
          join(sessions, "agent.json"),
          script,
        ],
        env: { PATH: "/usr/bin:/bin" },
      },
    });
    expect(result.run.errorMessage).toBeUndefined();
    expect(result.probe).toEqual({
      path: ".agents/probes/no-raw-sql.ts",
      content: Buffer.from("export {};\n").toString("base64"),
      entry: { paths: ["src/**"], failOn: "P1" },
    });
    expect(existsSync(join(worktree, "note.txt"))).toBe(false);
    expect(git("-C", worktree, "rev-parse", "HEAD")).toBe(git("-C", origin, "rev-parse", "main"));
    const turn = [
      ...new Bun.Glob("*/sessions/agent.json").scanSync(join(root, "work", ".paws", "runs")),
    ];
    const calls = JSON.parse(readFileSync(join(root, "work", ".paws", "runs", turn[0]!), "utf8"));
    expect(calls.fs.map((call: { ok: boolean }) => call.ok)).toEqual([true, false]);
  },
  30_000,
);
