import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  markRunnerAccountSignedIn,
  openRunnerAccountHome,
  publishRunnerAccountHome,
  runnerAccountHome,
} from "../src/runner-execution";
import {
  RunnerCommandSchema,
  runnerHelperLifetime,
  type RunnerAccount,
  type RunnerCommand,
} from "../src/runner-protocol";
import { executeRunnerCommand } from "../src/runner-worker";

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
const distill: Helper = {
  ...base,
  sessionId: "probes-distill",
  purpose: "probe_distill",
  prompt: "Distill.",
};

async function run(command: Helper, steps: (checkout: string) => unknown[], signedIn = true) {
  RunnerCommandSchema.parse(command);
  const root = mkdtempSync(join(tmpdir(), "paws-probe-helper-"));
  roots.push(root);
  const agentHome = join(root, "agent");
  mkdirSync(agentHome, { mode: 0o700 });
  const accountHome = runnerAccountHome(agentHome, account);
  if (signedIn)
    publishRunnerAccountHome(
      openRunnerAccountHome(agentHome, account, "codex", { signIn: true }),
      "01J00000000000000000000009",
      () => {
        writeFileSync(join(accountHome, ".codex", "auth.json"), "{}");
        markRunnerAccountSignedIn(accountHome, account, "codex");
      },
    );
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
    ...(command.repositories
      ? {
          helperRepositories: () => [{ repository: "acme/web", commit, path: snapshot }],
        }
      : {}),
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

test("probe_write runs under the account home and returns only the probe it wrote", async () => {
  const entry = '```json\n{"failOn":"P1"}\n```';
  const { result, calls, accountHome, checkout } = await run(write, (folder) => [
    put(join(folder, ".agents/probes/no-raw-sql.ts")),
    put(join(folder, ".agents/probes/scratch.ts"), "y"),
    reply(entry),
    { type: "end" },
  ]);
  expect(calls.fs.map((call: { ok: boolean }) => call.ok)).toEqual([true, true]);
  expect(calls.codexHome).toBe(join(accountHome, ".codex"));
  expect(calls.mcpServers).toEqual([]);
  expect(result.run.stopReason).toBe("end_turn");
  expect(result.text).toBe(entry);
  expect(result.probe).toEqual({ path: ".agents/probes/no-raw-sql.ts", text: "x" });
  expect(readFileSync(join(checkout, "src", "index.ts"), "utf8")).toBe("export {};\n");
}, 15_000);

test("probe_write returns no probe when the agent changed a file outside .agents/probes", async () => {
  const { result } = await run(write, (folder) => [
    put(join(folder, ".agents/probes/no-raw-sql.ts")),
    put(join(folder, "src/index.ts")),
    reply('```json\n{"failOn":"P1"}\n```'),
    { type: "end" },
  ]);
  expect(result.probe).toBeUndefined();
  expect(result.run).toMatchObject({
    stopReason: "error",
    errorMessage: "The agent changed files outside .agents/probes/: src/index.ts",
  });
}, 15_000);

test("probe_distill answers as text under the account home and writes nothing", async () => {
  const { result, calls, accountHome } = await run(distill, () => [
    put("note.txt"),
    reply('{"candidates":[]}'),
    { type: "end" },
  ]);
  expect(calls.fs.map((call: { ok: boolean }) => call.ok)).toEqual([false]);
  expect(result.text).toBe('{"candidates":[]}');
  expect(result.probe).toBeUndefined();
  expect(calls.codexHome).toBe(join(accountHome, ".codex"));
  expect(calls.mcpServers).toEqual([]);
}, 15_000);

test("a probe turn without its account home is refused before the agent starts", async () => {
  for (const command of [write, distill])
    await expect(run(command, () => [{ type: "end" }], false)).rejects.toThrow(
      "Agent account binding is not signed in on this runner",
    );
  expect(roots.map((root) => existsSync(join(root, "agent.json")))).toEqual([false, false]);
});
