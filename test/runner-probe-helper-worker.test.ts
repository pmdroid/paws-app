import { afterEach, expect, test } from "bun:test";
import { helperSandboxStarts } from "./helper-sandbox";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerAccountHome } from "../src/runner-execution";
import { runnerHelperLifetime, type RunnerCommand } from "../src/runner-protocol";
import { executeRunnerCommand } from "../src/runner-worker";
import { signInRunnerAccount } from "./runner-account-home";

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
const distill: Extract<RunnerCommand, { type: "helper" }> = {
  id: randomUUID(),
  type: "helper",
  runnerId: "runner",
  workspaceId: "workspace",
  issuedAt: now,
  expiresAt: now + runnerHelperLifetime("probe_distill"),
  sessionId: "probes-distill",
  sessionGeneration: 0,
  purpose: "probe_distill",
  profile: { agent: "codex", model: "fixture-model" },
  prompt: "Distill these sources.",
  account,
};

test.skipIf(!sandbox)(
  "a probe_distill turn can't write into its worktree",
  async () => {
    const root = mkdtempSync(join(homedir(), ".paws-probe-distill-"));
    roots.push(root);
    const agentHome = join(root, "agent");
    mkdirSync(agentHome, { mode: 0o700 });
    signInRunnerAccount(agentHome, "codex", account);
    const sessions = join(runnerAccountHome(agentHome, account), ".codex", "sessions");
    mkdirSync(sessions, { recursive: true });
    const worktree = join(root, "work", executionId);
    const script = join(root, "script.json");
    writeFileSync(
      script,
      JSON.stringify({
        model: "fixture-model",
        steps: [
          { type: "fs_write", path: "note.txt", content: "x" },
          {
            type: "update",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "{}" } },
          },
          { type: "write_file", path: join(worktree, "made.txt"), content: "x" },
          { type: "end" },
        ],
      }),
    );
    mkdirSync(join(root, "output"));
    const { run } = await executeRunnerCommand({
      job: { executionId, command: distill },
      outputDirectory: join(root, "output"),
      workRoot: join(root, "work"),
      home: agentHome,
      resultsGid: process.getgid!(),
      launch: {
        command: process.execPath,
        args: [
          "--no-env-file",
          fileURLToPath(new URL("../src/acp/testing/fake-agent.ts", import.meta.url)),
          join(sessions, "agent.json"),
          script,
        ],
        env: { PATH: "/usr/bin:/bin" },
      },
    });
    expect(run.errorMessage).toContain("EROFS");
    expect(existsSync(join(worktree, "note.txt"))).toBe(false);
    expect(existsSync(join(worktree, "made.txt"))).toBe(false);
    expect(existsSync(join(sessions, "agent.json"))).toBe(false);
    const turn = [
      ...new Bun.Glob("*/sessions/agent.json").scanSync(join(root, "work", ".paws", "runs")),
    ];
    const calls = JSON.parse(readFileSync(join(root, "work", ".paws", "runs", turn[0]!), "utf8"));
    expect(calls.fs.map((call: { ok: boolean }) => call.ok)).toEqual([false]);
  },
  30_000,
);
