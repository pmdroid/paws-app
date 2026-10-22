import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  createDirectWorkerSupervisor,
  createRunnerSkillInstaller,
  publishRunnerJob,
  type RunnerJob,
} from "../src/runner-execution";

const roots: string[] = [];
const pids: number[] = [];
const id = "01K00000000000000000000000";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function remember(pid: number | undefined): number {
  if (pid === undefined) throw new Error("Runner worker did not start");
  pids.push(pid);
  return pid;
}

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

test("direct worker supervisor admits an execution once and kills its process group", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-worker-supervisor-"));
  roots.push(root);
  let pid = 0;
  const supervisor = createDirectWorkerSupervisor({
    stateRoot: join(root, "workers"),
    launch(executionId) {
      const child = spawn(
        process.execPath,
        ["-e", `setTimeout(() => {}, 30000); void ${JSON.stringify(executionId)}`],
        {
          detached: true,
          stdio: "ignore",
        },
      );
      pid = remember(child.pid);
      return child;
    },
  });
  expect(await supervisor.start(id)).toEqual({ alreadyAdmitted: false });
  expect(await supervisor.start(id)).toEqual({ alreadyAdmitted: true });
  await supervisor.stop(id);
  expect(alive(pid)).toBe(false);
  await supervisor.stop(id);
});

test("stop kills a worker that has not become its process group", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-worker-supervisor-"));
  roots.push(root);
  const started = spawnSync(
    process.execPath,
    [
      "-e",
      [
        'const {spawn}=require("node:child_process");',
        'const child=spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{stdio:"ignore"});',
        "child.unref();",
        "process.stdout.write(String(child.pid));",
      ].join(""),
    ],
    { encoding: "utf8" },
  );
  const pid = Number(started.stdout);
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`orphan worker did not start: ${started.stderr}`);
  }
  remember(pid);
  let groupMissing = false;
  try {
    process.kill(-pid, 0);
  } catch (error) {
    groupMissing = (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  expect(groupMissing).toBe(true);
  expect(alive(pid)).toBe(true);
  const supervisor = createDirectWorkerSupervisor({
    stateRoot: join(root, "workers"),
    launch() {
      return { pid, unref() {} };
    },
  });
  expect(await supervisor.start(id)).toEqual({ alreadyAdmitted: false });
  await supervisor.stop(id);
  expect(alive(pid)).toBe(false);
});

const probe: RunnerJob = {
  executionId: id,
  command: {
    id: "cmd",
    runnerId: "runner",
    workspaceId: "ws",
    issuedAt: 1,
    expiresAt: 2,
    type: "probe",
    profile: { agent: "codex", model: null },
  },
};

function prepared(root: string) {
  const spoolRoot = join(root, "spool");
  mkdirSync(spoolRoot, { mode: 0o750 });
  chmodSync(spoolRoot, 0o750);
  const resultsRoot = join(root, "results");
  mkdirSync(resultsRoot, { mode: 0o750 });
  chmodSync(resultsRoot, 0o750);
  const spool = { root: spoolRoot, runnerUid: process.getuid!(), agentGid: process.getgid!() };
  publishRunnerJob(spool, probe);
  return {
    spool,
    results: { root: resultsRoot, agentUid: process.getuid!(), resultsGid: process.getgid!() },
  };
}

test("a failed launch removes the admission receipt and creates the result directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-worker-supervisor-"));
  roots.push(root);
  const { spool, results } = prepared(root);
  let fail = true;
  const supervisor = createDirectWorkerSupervisor({
    stateRoot: join(root, "workers"),
    spool,
    results,
    launch() {
      if (fail) throw new Error("Runner worker did not start");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        detached: true,
        stdio: "ignore",
      });
      remember(child.pid);
      return child;
    },
  });
  await expect(supervisor.start(id)).rejects.toThrow("Runner worker did not start");
  expect(statSync(join(results.root, id)).mode & 0o777).toBe(0o750);
  fail = false;
  expect(await supervisor.start(id)).toEqual({ alreadyAdmitted: false });
  await supervisor.stop(id);
});

test("a symlinked result directory is not retargeted", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-worker-supervisor-"));
  roots.push(root);
  const { spool, results } = prepared(root);
  const secret = join(root, "secret");
  writeFileSync(secret, "nope", { mode: 0o600 });
  chmodSync(secret, 0o600);
  symlinkSync(secret, join(results.root, id));
  const supervisor = createDirectWorkerSupervisor({
    stateRoot: join(root, "workers"),
    spool,
    results,
    launch() {
      throw new Error("launch must not run");
    },
  });
  await expect(supervisor.start(id)).rejects.toThrow();
  expect(statSync(secret).mode & 0o777).toBe(0o600);
  expect(lstatSync(join(results.root, id)).isSymbolicLink()).toBe(true);
});

test("a new agent home has the current skills when its first worker starts, pinned until stop", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-worker-supervisor-"));
  roots.push(root);
  const { spool, results } = prepared(root);
  publishRunnerJob(spool, {
    executionId: "01K00000000000000000000001",
    command: { ...probe.command, id: "cmd-home" },
  });
  const bytes = await new Bun.Archive({ "SKILL.md": "impeccable" }, { compress: "gzip" }).bytes();
  const agentHome = join(root, "agent");
  const skills = createRunnerSkillInstaller({
    root: join(root, "skills"),
    homes: [agentHome],
    owner: { uid: process.getuid!(), gid: process.getgid!() },
    download: async () => bytes,
  });
  await skills.sync([
    {
      name: "impeccable",
      version: "2.4.1",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      agents: ["claude"],
    },
  ]);
  // The home did not exist when the skills arrived, as on a freshly installed runner.
  mkdirSync(agentHome);
  const holds: string[] = [];
  let seen = "";
  const supervisor = createDirectWorkerSupervisor({
    stateRoot: join(root, "workers"),
    spool,
    results,
    agentHome,
    skills: {
      prepareHome: (home) => skills.prepareHome(home),
      hold: (home, executionId) => {
        holds.push(`hold ${executionId}`);
        skills.hold(home, executionId);
      },
      release: (executionId) => {
        holds.push(`release ${executionId}`);
        skills.release(executionId);
      },
    },
    launch(_executionId, home) {
      seen = readFileSync(join(home, ".claude/skills/impeccable/SKILL.md"), "utf8");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        detached: true,
        stdio: "ignore",
      });
      remember(child.pid);
      return child;
    },
  });
  await supervisor.start("01K00000000000000000000001");
  expect(seen).toBe("impeccable");
  await supervisor.stop("01K00000000000000000000001");
  expect(holds).toEqual(["hold 01K00000000000000000000001", "release 01K00000000000000000000001"]);
});
