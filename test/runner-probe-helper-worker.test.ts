import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

type Helper = Extract<RunnerCommand, { type: "helper" }>;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const account: RunnerAccount = {
  accountId: "01JACCOUNTA000000000000000",
  bindingId: "01JBINDINGA000000000000000",
};
const executionId = "01J00000000000000000000001";
const commit = "a".repeat(40);
const now = Date.now();
const base = {
  id: randomUUID(),
  type: "helper",
  runnerId: "runner",
  workspaceId: "workspace",
  issuedAt: now,
  expiresAt: now + runnerHelperLifetime("probe_write"),
  sessionGeneration: 0,
  profile: { agent: "codex", model: "fixture-model" },
  account,
} as const;
const write: Helper = {
  ...base,
  sessionId: "probes-write",
  purpose: "probe_write",
  prompt: "Write the probe for no-raw-sql.",
  probe: { repository: "acme/web", path: ".agents/probes/no-raw-sql.ts" },
  repositories: ["acme/web"],
};
const distill: Helper = { ...base, sessionId: "d", purpose: "probe_distill", prompt: "Distill." };

async function run(command: Helper, steps: (checkout: string) => unknown[], signedIn = true) {
  RunnerCommandSchema.parse(command);
  const root = mkdtempSync(join(tmpdir(), "paws-probe-helper-"));
  roots.push(root);
  const agentHome = join(root, "agent");
  mkdirSync(agentHome, { mode: 0o700 });
  const accountHome = runnerAccountHome(agentHome, account);
  if (signedIn) signInRunnerAccount(agentHome, "codex", account);
  const snapshot = join(root, "snapshot");
  mkdirSync(join(snapshot, "src"), { recursive: true });
  writeFileSync(join(snapshot, "src", "index.ts"), "export {};\n");
  const checkout = join(root, "work", executionId, "repositories", "acme", "web");
  const outputDirectory = join(root, "output");
  mkdirSync(outputDirectory);
  const script = join(root, "script.json");
  const recorded = join(root, "agent.json");
  writeFileSync(script, JSON.stringify({ model: "fixture-model", steps: steps(checkout) }));
  const result = await executeRunnerCommand({
    job: { executionId, command },
    outputDirectory,
    workRoot: join(root, "work"),
    home: agentHome,
    resultsGid: process.getgid!(),
    helperRepositories: () => [{ repository: "acme/web", commit, path: snapshot }],
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
  return { result, calls: JSON.parse(readFileSync(recorded, "utf8")), accountHome, checkout };
}

const reply = (text: string) => ({
  type: "update",
  update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
});
const put = (path: string, content = "x") => ({ type: "fs_write", path, content });

const edit = (toolCallId: string, path: string) => ({
  type: "permission",
  toolCall: { toolCallId, kind: "edit", locations: [{ path }] },
});

test("probe_write may write only under .agents/probes and returns the probe and its rules entry", async () => {
  const entry = '```json\n{"failOn":"P1"}\n```';
  const { result, calls, accountHome, checkout } = await run(write, (folder) => [
    edit("probe", ".agents/probes/no-raw-sql.ts"),
    edit("source", "src/index.ts"),
    put(".agents/probes/no-raw-sql.ts"),
    put(".agents/probes/scratch.ts", "y"),
    put("src/index.ts"),
    put(join(folder, "../../../outside.txt")),
    { type: "terminal", command: "touch", args: ["src/x"] },
    reply(entry),
    { type: "end" },
  ]);
  expect(
    calls.permissions.map(
      (call: { outcome: { outcome: { optionId: string } } }) => call.outcome.outcome.optionId,
    ),
  ).toEqual(["allow", "deny"]);
  expect(calls.fs.map((call: { ok: boolean }) => call.ok)).toEqual([true, true, false, false]);
  expect(calls.codexHome).toBe(join(accountHome, ".codex"));
  expect(calls.mcpServers).toEqual([]);
  expect(result.run.stopReason).toBe("end_turn");
  expect(result.text).toBe(entry);
  expect(result.probe).toEqual({ path: ".agents/probes/no-raw-sql.ts", text: "x" });
  expect(readFileSync(join(checkout, "src", "index.ts"), "utf8")).toBe("export {};\n");
  expect(existsSync(join(checkout, "src", "x"))).toBe(false);
  expect(existsSync(join(checkout, "../../outside.txt"))).toBe(false);
}, 15_000);

test("probe_write fails without a new probe or after a change outside .agents/probes", async () => {
  for (const [file, error] of [
    [".agents/probes/other.ts", "The agent did not write .agents/probes/no-raw-sql.ts"],
    ["src/index.ts", "The agent changed files outside .agents/probes/: src/index.ts"],
  ]) {
    const { result } = await run(write, (folder) => [
      { type: "write_file", path: join(folder, file!), content: "x" },
      { type: "end" },
    ]);
    expect(result).toMatchObject({ run: { stopReason: "error", errorMessage: error } });
    expect(result.probe).toBeUndefined();
  }
}, 15_000);

test("probe_distill answers as text under the account home and writes nothing", async () => {
  const { result, calls, accountHome } = await run(distill, () => [
    put("note.txt"),
    reply('{"candidates":[]}'),
    { type: "end" },
  ]);
  expect(calls.fs.map((call: { ok: boolean }) => call.ok)).toEqual([false]);
  expect(result.text).toBe('{"candidates":[]}');
  expect(calls.codexHome).toBe(join(accountHome, ".codex"));
}, 15_000);

test("a probe turn without its account home is refused before the agent starts", async () => {
  for (const command of [write, distill])
    await expect(run(command, () => [{ type: "end" }], false)).rejects.toThrow(
      "Agent account binding is not signed in on this runner",
    );
  expect(roots.map((root) => existsSync(join(root, "agent.json")))).toEqual([false, false]);
});
