import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RUNNER_SLACK_REPLY_MS,
  runnerHelperLifetime,
  type RunnerCommand,
} from "../src/runner-protocol";
import { executeRunnerCommand } from "../src/runner-worker";

type Helper = Extract<RunnerCommand, { type: "helper" }>;
const now = Date.now();
const base = {
  id: randomUUID(),
  type: "helper",
  runnerId: "runner",
  workspaceId: "workspace",
  issuedAt: now,
  profile: { agent: "claude", model: "fixture-model" },
} as const;

test("a Slack reply answers from its prompt and cannot read or write outside its empty folder", async () => {
  const calls = await sandboxed({
    ...base,
    expiresAt: now + RUNNER_SLACK_REPLY_MS,
    sessionId: "slack-request",
    sessionGeneration: 3,
    purpose: "slack_reply",
    prompt: "Ada: what does the release checklist cover?",
    slack: {
      requestId: "slack-request",
      teamId: "T0ACME",
      channelId: "C0GENERAL",
      threadTs: "1795053091.151000",
      memberUserId: "member-ada",
      installGeneration: 3,
    },
  });
  expect(JSON.stringify(calls.prompts)).toContain("Slack channel thread");
}, 15_000);

test("a repository summary answers from its prompt and cannot read or write outside its empty folder", async () => {
  await sandboxed({
    ...base,
    expiresAt: now + runnerHelperLifetime("repository_summary"),
    sessionId: "summary-request",
    sessionGeneration: 0,
    purpose: "repository_summary",
    prompt: "Summarise this README: release checklist.",
    summary: { repository: "acme/web" },
  });
}, 15_000);

async function sandboxed(input: Helper) {
  const root = mkdtempSync(join(tmpdir(), "paws-sandboxed-helper-worker-"));
  try {
    const outputDirectory = join(root, "output");
    const home = join(root, "home");
    const secret = join(root, "other-checkout", "secret.txt");
    mkdirSync(outputDirectory);
    mkdirSync(home);
    mkdirSync(join(root, "other-checkout"));
    writeFileSync(secret, "not for Slack");
    const script = join(root, "script.json");
    const recorded = join(root, "agent.json");
    writeFileSync(
      script,
      JSON.stringify({
        model: "fixture-model",
        steps: [
          { type: "fs_read", path: secret },
          { type: "fs_read", path: join(home, ".claude.json") },
          { type: "fs_write", path: "note.txt", content: "denied" },
          {
            type: "permission",
            toolCall: {
              toolCallId: "read-other",
              kind: "read",
              locations: [{ path: secret }],
              rawInput: { file_path: secret },
            },
          },
          {
            type: "update",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "It covers the changelog and the tag." },
            },
          },
          { type: "end" },
        ],
      }),
    );
    const result = await executeRunnerCommand({
      job: { executionId: "0".repeat(26), command: input },
      outputDirectory,
      workRoot: join(root, "work"),
      home,
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
    expect(result.text).toBe("It covers the changelog and the tag.");
    const calls = JSON.parse(readFileSync(recorded, "utf8"));
    expect(calls.mcpServers).toEqual([]);
    expect(calls.fs.map((entry: { ok: boolean }) => entry.ok)).toEqual([false, false, false]);
    expect(JSON.stringify(calls.fs)).not.toContain("not for Slack");
    expect(JSON.stringify(calls.permissions[0].outcome)).not.toContain('"allow"');
    expect(JSON.stringify(calls.prompts)).toContain(input.prompt);
    return calls;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
