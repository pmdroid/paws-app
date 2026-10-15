import { spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
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
  publishRunnerJob,
  type RunnerJob,
} from "../src/runner-execution";

const roots: string[] = [];
const id = "01K00000000000000000000000";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("direct worker supervisor admits an execution once and kills its process group", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-worker-supervisor-"));
  roots.push(root);
  const supervisor = createDirectWorkerSupervisor({
    stateRoot: join(root, "workers"),
    launch(executionId) {
      return spawn(
        process.execPath,
        ["-e", `setTimeout(() => {}, 30000); void ${JSON.stringify(executionId)}`],
        {
          detached: true,
          stdio: "ignore",
        },
      );
    },
  });
  expect(await supervisor.start(id)).toEqual({ alreadyAdmitted: false });
  expect(await supervisor.start(id)).toEqual({ alreadyAdmitted: true });
  await supervisor.stop(id);
  await supervisor.stop(id);
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
      return spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
        detached: true,
        stdio: "ignore",
      });
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
