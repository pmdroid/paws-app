import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeRunnerCommand } from "../../src/runner-worker";

// A runner worker that runs one repository-free task with the fake agent and its script.
const [root, executionId] = process.argv.slice(2) as [string, string];
await executeRunnerCommand({
  job: {
    executionId,
    command: {
      id: "command",
      type: "task",
      runnerId: "runner",
      workspaceId: "workspace",
      runId: "run",
      itemId: "item",
      generation: 1,
      sessionId: "session",
      sessionGeneration: 1,
      taskModeGeneration: 1,
      purpose: "answer",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      profile: { agent: "claude", model: "fixture-model" },
      prompt: "Start a sandbox",
    },
  },
  outputDirectory: join(root, "output"),
  workRoot: join(root, "work"),
  home: join(root, "home"),
  resultsGid: process.getgid!(),
  launch: {
    command: process.execPath,
    args: [
      "--no-env-file",
      fileURLToPath(new URL("../../src/acp/testing/fake-agent.ts", import.meta.url)),
      join(root, "trace.json"),
      join(root, "script.json"),
    ],
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
  },
  answer: async () => ({ answer: "" }),
});
