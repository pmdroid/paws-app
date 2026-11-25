import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  createDirectWorkerSupervisor,
  publishRunnerJob,
  type RunnerJob,
} from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";

const roots: string[] = [];
const pids: number[] = [];

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "paws-account-required-"));
  roots.push(root);
  return root;
}

async function execute(command: RunnerJob["command"]) {
  const root = tempRoot();
  const home = join(root, "home");
  const outputDirectory = join(root, "output");
  for (const path of [home, join(root, "work"), outputDirectory]) mkdirSync(path);
  let loginChecked = false;
  const result = await executeRunnerCommand({
    job: { executionId: "01J00000000000000000000003", command },
    outputDirectory,
    workRoot: join(root, "work"),
    home,
    resultsGid: process.getgid!(),
    launch: { command: "/forbidden-acp-agent" },
    providerCli: () => "/forbidden-provider-cli",
    loginCommand: async () => {
      loginChecked = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  return { result, home, outputDirectory, loginChecked };
}

test("a sign-in check without an account reports no sign-in and starts nothing", async () => {
  const { result, home, outputDirectory, loginChecked } = await execute({
    id: "check",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: 1,
    expiresAt: Date.now() + 60_000,
    type: "login_check",
    agent: "codex",
  });
  expect(result.run).toMatchObject({
    stopReason: "error",
    errorMessage: "No signed-in codex account on this runner",
    authRequired: true,
    agentExited: false,
  });
  expect(result.login).toEqual({
    agent: "codex",
    authenticated: false,
    method: "none",
    command: "codex login --device-auth",
  });
  expect(loginChecked).toBe(false);
  expect(JSON.parse(readFileSync(join(outputDirectory, "result.json"), "utf8"))).toEqual(result);
  expect(readFileSync(join(outputDirectory, "events.jsonl"), "utf8")).toBe("");
  for (const folder of [".codex", ".claude", ".grok", ".paws-accounts"])
    expect(existsSync(join(home, folder))).toBe(false);
});

test("a helper without an account fails as signed out before its agent starts", async () => {
  const { result, home } = await execute({
    id: "helper",
    type: "helper",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    profile: { agent: "claude", model: "fixture-model" },
    sessionId: "summary-request",
    sessionGeneration: 0,
    purpose: "repository_summary",
    prompt: "Summarise this README.",
    summary: { repository: "acme/web" },
  });
  expect(result.run).toMatchObject({
    role: "implementer",
    stopReason: "error",
    errorMessage: "No signed-in claude account on this runner",
    authRequired: true,
  });
  expect(result.login).toBeUndefined();
  expect(existsSync(join(home, ".claude"))).toBe(false);
});

test("the supervisor prepares no home for a job without an account", async () => {
  const root = tempRoot();
  const spoolRoot = join(root, "spool");
  mkdirSync(spoolRoot, { mode: 0o750 });
  chmodSync(spoolRoot, 0o750);
  const resultsRoot = join(root, "results");
  mkdirSync(resultsRoot, { mode: 0o770 });
  chmodSync(resultsRoot, 0o770);
  const spool = { root: spoolRoot, runnerUid: process.getuid!(), agentGid: process.getgid!() };
  const executionId = "01K00000000000000000000004";
  publishRunnerJob(spool, {
    executionId,
    command: {
      id: "cmd",
      runnerId: "runner",
      workspaceId: "ws",
      issuedAt: 1,
      expiresAt: 2,
      type: "login_check",
      agent: "claude",
    },
  });
  const agentHome = join(root, "agent");
  mkdirSync(agentHome, { mode: 0o700 });
  const preparedHomes: string[] = [];
  const heldHomes: string[] = [];
  const launched: { home: string; skills?: string }[] = [];
  const supervisor = createDirectWorkerSupervisor({
    stateRoot: join(root, "workers"),
    spool,
    results: { root: resultsRoot, agentUid: process.getuid!(), resultsGid: process.getgid!() },
    agentHome,
    skills: {
      prepareHome: (home) => preparedHomes.push(home),
      hold: (home) => {
        heldHomes.push(home);
        return join(root, "skills");
      },
      release: () => {},
    },
    launch(_executionId, home, _log, _resume, _tag, skills) {
      launched.push({ home, ...(skills ? { skills } : {}) });
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        detached: true,
        stdio: "ignore",
      });
      if (child.pid !== undefined) pids.push(child.pid);
      return child;
    },
  });
  await supervisor.start(executionId);
  expect(launched).toEqual([{ home: agentHome }]);
  expect(preparedHomes).toEqual([]);
  expect(heldHomes).toEqual([]);
  expect(existsSync(join(agentHome, ".paws-active"))).toBe(false);
  await supervisor.stop(executionId);
});
