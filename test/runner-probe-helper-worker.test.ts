import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runnerAccountHome } from "../src/runner-execution";
import {
  RunnerCommandSchema,
  runnerHelperLifetime,
  type RunnerAccount,
  type RunnerCommand,
} from "../src/runner-protocol";
import { executeRunnerCommand } from "../src/runner-worker";
import { signInRunnerAccount } from "./runner-account-home";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const account: RunnerAccount = {
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

async function run(steps: unknown[], signedIn = true) {
  RunnerCommandSchema.parse(distill);
  const root = mkdtempSync(join(tmpdir(), "paws-probe-helper-"));
  roots.push(root);
  const agentHome = join(root, "agent");
  mkdirSync(agentHome, { mode: 0o700 });
  if (signedIn) signInRunnerAccount(agentHome, "codex", account);
  const outputDirectory = join(root, "output");
  mkdirSync(outputDirectory);
  const script = join(root, "script.json");
  const recorded = join(root, "agent.json");
  writeFileSync(script, JSON.stringify({ model: "fixture-model", steps }));
  const result = await executeRunnerCommand({
    job: { executionId, command: distill },
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
  return { result, calls, accountHome: runnerAccountHome(agentHome, account), root };
}

test("probe_distill answers as text under the account home and writes nothing", async () => {
  const { result, calls, accountHome, root } = await run([
    { type: "fs_write", path: "note.txt", content: "denied" },
    {
      type: "permission",
      toolCall: { toolCallId: "edit", kind: "edit", locations: [{ path: "note.txt" }] },
    },
    { type: "terminal", command: "touch", args: ["made.txt"] },
    {
      type: "update",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: '{"candidates":[]}' },
      },
    },
    { type: "end" },
  ]);
  expect(result.run.stopReason).toBe("end_turn");
  expect(result.text).toBe('{"candidates":[]}');
  expect(calls.codexHome).toBe(join(accountHome, ".codex"));
  expect(calls.mcpServers).toEqual([]);
  expect(calls.fs.map((call: { ok: boolean }) => call.ok)).toEqual([false]);
  expect(calls.permissions[0].outcome).toEqual({
    outcome: { outcome: "selected", optionId: "deny" },
  });
  const work = join(root, "work", executionId);
  const written = existsSync(work) ? readdirSync(work, { recursive: true }).map(String) : [];
  expect(written.filter((path) => /note\.txt|made\.txt/.test(path))).toEqual([]);
}, 15_000);

test("a probe_distill turn without its account home is refused before the agent starts", async () => {
  await expect(run([{ type: "end" }], false)).rejects.toThrow(
    "Agent account binding is not signed in on this runner",
  );
  expect(existsSync(join(roots[0]!, "agent.json"))).toBe(false);
});
