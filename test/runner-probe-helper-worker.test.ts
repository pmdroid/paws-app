import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  markRunnerAccountSignedIn,
  openRunnerAccountHome,
  publishRunnerAccountHome,
} from "../src/runner-execution";
import {
  RunnerCommandSchema,
  runnerHelperLifetime,
  type RunnerAccount,
  type RunnerCommand,
} from "../src/runner-protocol";
import { executeRunnerCommand } from "../src/runner-worker";

const account: RunnerAccount = {
  accountId: "01JACCOUNTA000000000000000",
  bindingId: "01JBINDINGA000000000000000",
};
const now = Date.now();

test("probe_distill answers as text under the account home without host access", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-probe-helper-"));
  try {
    const command: Extract<RunnerCommand, { type: "helper" }> = {
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
    RunnerCommandSchema.parse(command);
    const agentHome = join(root, "agent");
    mkdirSync(agentHome, { mode: 0o700 });
    const accountHome = openRunnerAccountHome(agentHome, account, "codex", { signIn: true });
    publishRunnerAccountHome(accountHome, "01J00000000000000000000009", () => {
      writeFileSync(join(accountHome, ".codex", "auth.json"), "{}");
      markRunnerAccountSignedIn(accountHome, account, "codex");
    });
    const outputDirectory = join(root, "output");
    mkdirSync(outputDirectory);
    const script = join(root, "script.json");
    const recorded = join(root, "agent.json");
    writeFileSync(
      script,
      JSON.stringify({
        model: "fixture-model",
        steps: [
          { type: "fs_write", path: "note.txt", content: "denied" },
          {
            type: "update",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: '{"candidates":[]}' },
            },
          },
          { type: "end" },
        ],
      }),
    );
    const result = await executeRunnerCommand({
      job: { executionId: "01J00000000000000000000001", command },
      outputDirectory,
      workRoot: join(root, "work"),
      home: agentHome,
      resultsGid: process.getgid!(),
      launch: {
        command: process.execPath,
        args: [
          "--no-env-file",
          fileURLToPath(new URL("../src/acp/testing/fake-agent.ts", import.meta.url)),
          recorded,
          script,
        ],
        env: { PATH: "/usr/bin:/bin" },
      },
    });
    const calls = JSON.parse(readFileSync(recorded, "utf8"));
    expect(result.text).toBe('{"candidates":[]}');
    expect(calls.codexHome).toBe(join(accountHome, ".codex"));
    expect(calls.mcpServers).toEqual([]);
    expect(calls.fs.map((call: { ok: boolean }) => call.ok)).toEqual([false]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
