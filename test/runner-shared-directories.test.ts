import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  accountHomeVerdict,
  createDirectWorkerSupervisor,
  createRunnerResultDirectory,
  publishRunnerJob,
  runnerResultDirectoryRule,
  runnerResultsRootRule,
  clearInheritedSetgid,
  sharedDirectoryAllowed,
} from "../src/runner-execution";

const runner = 1001;
const agent = 1002;
const agentGroup = 2002;
const resultsGroup = 2003;
const directory = (uid: number, gid: number, mode: number) => ({ uid, gid, mode: 0o040000 | mode });
const executionId = "01K00000000000000000000000";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "paws-shared-directories-"));
  roots.push(root);
  return root;
}

function chowns() {
  return ["chownSync", "fchownSync", "lchownSync"].map((name) =>
    spyOn(fs, name as "chownSync" | "fchownSync" | "lchownSync"),
  );
}

test("the supervisor makes a task directory the agent group can write, without a chown", async () => {
  const root = temporary();
  const spool = {
    root: join(root, "spool"),
    runnerUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
  mkdirSync(spool.root, { mode: 0o750 });
  chmodSync(spool.root, 0o750);
  const results = {
    root: join(root, "results"),
    agentUid: process.getuid!(),
    resultsGid: process.getgid!(),
  };
  mkdirSync(results.root, { mode: 0o770 });
  chmodSync(results.root, 0o770);
  const taskRoot = join(root, "tasks");
  mkdirSync(taskRoot, { mode: 0o770 });
  publishRunnerJob(spool, {
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
      prompt: "Answer",
    },
  });
  const spies = chowns();
  try {
    const supervisor = createDirectWorkerSupervisor({
      stateRoot: join(root, "workers"),
      spool,
      results,
      taskRoot,
      agentHome: join(root, "agent"),
      launch: () => ({ pid: process.pid, unref() {} }),
    });
    await supervisor.start(executionId);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  const task = statSync(join(taskRoot, executionId));
  expect([task.uid, task.gid, task.mode & 0o777]).toEqual([spool.runnerUid, spool.agentGid, 0o770]);
  expect(existsSync(join(results.root, executionId))).toBe(false);
});

test("a task directory under a setgid root carries no setgid bit, so copying its checkout keeps working", async () => {
  const root = temporary();
  const spool = {
    root: join(root, "spool"),
    runnerUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
  mkdirSync(spool.root, { mode: 0o750 });
  chmodSync(spool.root, 0o750);
  const results = {
    root: join(root, "results"),
    agentUid: process.getuid!(),
    resultsGid: process.getgid!(),
  };
  mkdirSync(results.root, { mode: 0o770 });
  chmodSync(results.root, 0o770);
  const taskRoot = join(root, "tasks");
  mkdirSync(taskRoot, { mode: 0o770 });
  chmodSync(taskRoot, 0o2770);
  publishRunnerJob(spool, {
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
      prompt: "Answer",
    },
  });
  const supervisor = createDirectWorkerSupervisor({
    stateRoot: join(root, "workers"),
    spool,
    results,
    taskRoot,
    agentHome: join(root, "agent"),
    launch: () => ({ pid: process.pid, unref() {} }),
  });
  await supervisor.start(executionId);
  expect(statSync(join(taskRoot, executionId)).mode & 0o7777).toBe(0o770);
});

test("a work root created under a setgid home loses the inherited setgid bit, and keeps its other bits", () => {
  const home = temporary();
  chmodSync(home, 0o2770);
  const work = join(home, "work");
  mkdirSync(work, { mode: 0o700 });
  expect(statSync(work).mode & 0o2000).toBe(0o2000);
  clearInheritedSetgid(work);
  expect(statSync(work).mode & 0o7777).toBe(0o700);
  clearInheritedSetgid(work);
  expect(statSync(work).mode & 0o7777).toBe(0o700);
});

test("the worker makes its own result directory, and a symlink in its place is refused", () => {
  const root = temporary();
  const results = {
    root: join(root, "results"),
    agentUid: process.getuid!(),
    resultsGid: process.getgid!(),
  };
  mkdirSync(results.root, { mode: 0o770 });
  chmodSync(results.root, 0o770);
  const made = createRunnerResultDirectory(results, executionId);
  expect(statSync(made).mode & 0o777).toBe(0o750);
  expect(createRunnerResultDirectory(results, executionId)).toBe(made);
  const other = "01K00000000000000000000001";
  symlinkSync(join(root, "elsewhere"), join(results.root, other));
  expect(() => createRunnerResultDirectory(results, other)).toThrow();
  chmodSync(results.root, 0o750);
  expect(() => createRunnerResultDirectory(results, executionId)).toThrow(/results root/);
});

test("results accept the shared layout and refuse other access or another group", () => {
  const results = {
    root: "/results",
    runnerUid: runner,
    agentUid: agent,
    resultsGid: resultsGroup,
  };
  const root = runnerResultsRootRule(results);
  const job = runnerResultDirectoryRule(results);
  expect(sharedDirectoryAllowed(directory(runner, resultsGroup, 0o2770), root)).toBe(true);
  expect(sharedDirectoryAllowed(directory(runner, resultsGroup, 0o2750), root)).toBe(false);
  expect(sharedDirectoryAllowed(directory(agent, resultsGroup, 0o2770), root)).toBe(false);
  expect(sharedDirectoryAllowed(directory(agent, resultsGroup, 0o2750), job)).toBe(true);
  expect(sharedDirectoryAllowed(directory(agent, resultsGroup, 0o2755), job)).toBe(false);
  expect(sharedDirectoryAllowed(directory(agent, agentGroup, 0o2750), job)).toBe(false);
  expect(sharedDirectoryAllowed(directory(runner, resultsGroup, 0o2750), job)).toBe(false);
});

test("an account home is shared through the agent group with either user", () => {
  const owners = { runnerUid: runner, agentGid: agentGroup };
  const shared = directory(runner, agentGroup, 0o2770);
  expect(accountHomeVerdict(shared, owners, runner)).toBe("shared");
  expect(accountHomeVerdict(shared, owners, agent)).toBe("shared");
  expect(accountHomeVerdict(directory(agent, agentGroup, 0o2770), owners, agent)).toBe("shared");
  expect(accountHomeVerdict(directory(runner, agentGroup, 0o2777), owners, agent)).toMatch(
    /other users/,
  );
  expect(accountHomeVerdict(directory(runner, agentGroup, 0o0777), owners, runner)).toMatch(
    /other users/,
  );
  expect(accountHomeVerdict(directory(runner, 2004, 0o2770), owners, agent)).toMatch(/agent group/);
  expect(accountHomeVerdict(directory(1003, agentGroup, 0o2770), owners, agent)).toMatch(
    /another user/,
  );
  expect(accountHomeVerdict(directory(runner, agentGroup, 0o0700), owners, runner)).toBe("repair");
  expect(accountHomeVerdict(directory(runner, agentGroup, 0o0700), owners, agent)).toMatch(
    /not shared/,
  );
  expect(accountHomeVerdict(directory(runner, agentGroup, 0o2700), owners, runner)).toMatch(
    /not shared/,
  );
});
