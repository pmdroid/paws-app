import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerJob } from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";

async function loginCheck(agent: "codex", authenticated: boolean, rateLimits: unknown) {
  const root = mkdtempSync(join(tmpdir(), "paws-agent-usage-"));
  try {
    const home = join(root, "home");
    const outputDirectory = join(root, "output");
    for (const path of [home, join(root, "work"), outputDirectory]) mkdirSync(path);
    const script = join(root, "script.json");
    writeFileSync(script, JSON.stringify({ model: "fixture-model", steps: [{ type: "hang" }] }));
    const job: RunnerJob = {
      executionId: "01J00000000000000000000003",
      command: {
        id: "check",
        runnerId: "runner",
        workspaceId: "workspace",
        issuedAt: 1,
        expiresAt: Date.now() + 60_000,
        type: "login_check",
        agent,
      },
    };
    const reads: NodeJS.ProcessEnv[] = [];
    const fake = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
    const result = await executeRunnerCommand({
      job,
      outputDirectory,
      workRoot: join(root, "work"),
      home,
      resultsGid: process.getgid!(),
      launch: { command: process.execPath, args: [fake, join(root, "trace.json"), script] },
      loginCommand: async () => ({ exitCode: authenticated ? 0 : 1, stdout: "", stderr: "" }),
      async codexRateLimits(env) {
        reads.push(env);
        if (rateLimits instanceof Error) throw rateLimits;
        return rateLimits;
      },
    });
    return { result, reads, home };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a Codex sign-in check reads its rate limits with the agent's home", async () => {
  const { result, reads, home } = await loginCheck("codex", true, {
    rateLimits: {
      primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1793082749 },
      secondary: null,
    },
  });
  expect(result.login?.authenticated).toBe(true);
  expect(result.run.agentLimits).toEqual([
    { window: "Weekly", usedPercent: 100, resetsAt: 1793082749_000 },
  ]);
  expect(reads).toHaveLength(1);
  expect(reads[0]!.HOME).toBe(home);
  expect(reads[0]!.GH_TOKEN).toBeUndefined();
}, 20_000);

test("a signed-out or unreadable Codex check reports no usage and still finishes", async () => {
  const signedOut = await loginCheck("codex", false, { rateLimits: {} });
  expect(signedOut.reads).toHaveLength(0);
  expect(signedOut.result.run.agentLimits).toBeUndefined();
  const failed = await loginCheck("codex", true, new Error("codex app-server is missing"));
  expect(failed.result.login?.authenticated).toBe(true);
  expect(failed.result.run.agentLimits).toBeUndefined();
}, 20_000);
