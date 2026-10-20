import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createExeDevBootstrap } from "../../src/provisioning";
import { createRepositoryPolicyReader, readRepositoryPolicy } from "../../src/runner-daemon";
import {
  signRunnerCommand,
  verifyRunnerCommand,
  type RunnerCommand,
} from "../../src/runner-protocol";
import { generateKeyPairSync } from "node:crypto";

const root = process.argv[2]!;
assert.equal(process.getuid!(), 0);
const policyPath = "/etc/paws-runner/repository-policy.json";
const log = join(root, "service.log");
const commands: string[] = [];
const bootstrap = createExeDevBootstrap({
  runnerVersion: "1.2.3",
  installer: "true",
  controlPlaneUrl: "https://fixture.invalid",
  runnerApiUrl: "https://fixture.invalid",
  mise: { version: "2026.10.15", sha256: { amd64: "a".repeat(64) } },
  exeDev: {
    async listVms() {
      return [];
    },
    async createVm() {
      throw new Error("No VM creation");
    },
    async execVm({ command }) {
      commands.push(command);
      const process = Bun.spawn(["/bin/sh", "-c", command], {
        env: {
          PATH: `${root}/bin:/usr/bin:/bin`,
          HOME: root,
          KYOTOAGENT_ROOT: `${root}/.kyotoagent`,
          SERVICE_LOG: log,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
        process.exited,
      ]);
      if (exitCode) writeFileSync(join(root, "guest-error.log"), stderr);
      return { stdout, stderr, exitCode };
    },
  },
});
const baseline = spawn("/bin/sleep", ["60"]);
writeFileSync(join(root, "active.pid"), String(baseline.pid));
const baselineStopped = new Promise<void>((resolve) => baseline.once("exit", () => resolve()));
const restarted = Bun.spawn(
  ["/bin/sh", join(root, "bin/systemctl"), "try-restart", "paws-runner.service"],
  {
    env: { PATH: "/usr/bin:/bin", SERVICE_LOG: log },
    stdout: "pipe",
    stderr: "pipe",
  },
);
assert.equal(await restarted.exited, 0);
await baselineStopped;
assert.equal(baseline.signalCode, "SIGTERM");
writeFileSync(log, "");
let activeExit: number | null = null;
const active = spawn("/bin/sleep", ["60"]);
active.once("exit", (code) => {
  activeExit = code;
});
writeFileSync(join(root, "active.pid"), String(active.pid));
const alive = () => {
  process.kill(active.pid!, 0);
  assert.equal(activeExit, null);
};
const observations: Record<string, unknown> = {
  baselineTryRestartKillsTaskA: { passed: true, signal: baseline.signalCode },
};
try {
  await bootstrap.allowRepositories("fixture", ["acme/a"], { revision: 1, fence: 1 });
  const read = createRepositoryPolicyReader(policyPath, 0);
  const keys = generateKeyPairSync("ed25519");
  const verify = (repo: string, id: string) => {
    const command: RunnerCommand = {
      id,
      type: "run",
      runnerId: "fixture",
      workspaceId: "workspace",
      issuedAt: 1000,
      expiresAt: 2000,
      runId: id,
      itemId: id,
      generation: 1,
      repository: {
        owner: "acme",
        repo,
        remoteUrl: `https://github.com/acme/${repo}.git`,
        baseSha: "a".repeat(40),
      },
      profile: { agent: "claude", model: null },
      prompt: "Fixture",
    };
    return verifyRunnerCommand(
      signRunnerCommand({ command, keyId: "fixture", privateKey: keys.privateKey }),
      {
        trustedKeys: new Map([["fixture", keys.publicKey]]),
        runnerId: "fixture",
        workspaceId: "workspace",
        now: 1500,
        allowedRepositories: read(),
        claimCommand: () => true,
      },
    );
  };
  assert.equal(verify("a", "a").ok, true);
  assert.equal(verify("b", "before-b").ok, false);
  await bootstrap.allowRepositories("fixture", ["acme/a", "acme/b"], { revision: 2, fence: 2 });
  assert.equal(verify("b", "after-b").ok, true);
  alive();
  assert.equal(readFileSync(log, "utf8"), "");
  observations.activeAauthorizeB = {
    passed: true,
    pid: active.pid,
    repositories: read(),
    serviceMutations: 0,
  };
  await bootstrap.allowRepositories("fixture", ["acme/b"], { revision: 3, fence: 3 });
  assert.equal(verify("a", "revoked-a").ok, false);
  alive();
  observations.revokeDoesNotCancelActiveA = { passed: true, repositories: read() };
  await assert.rejects(
    bootstrap.allowRepositories("fixture", ["acme/a"], { revision: 1, fence: 1 }),
  );
  assert.deepEqual(read(), ["acme/b"]);
  await assert.rejects(
    bootstrap.allowRepositories("fixture", ["acme/other"], { revision: 3, fence: 3 }),
  );
  observations.staleAndConflictingGuestWrites = { passed: true };
  const snapshot = readFileSync(policyPath);
  chmodSync(policyPath, 0o660);
  assert.throws(read);
  chmodSync(policyPath, 0o640);
  renameSync(policyPath, `${policyPath}.saved`);
  symlinkSync(`${policyPath}.saved`, policyPath);
  assert.throws(read);
  await assert.rejects(bootstrap.allowRepositories("fixture", [], { revision: 4, fence: 4 }));
  unlinkSync(policyPath);
  renameSync(`${policyPath}.saved`, policyPath);
  writeFileSync(policyPath, "x".repeat(65537));
  assert.throws(read);
  writeFileSync(policyPath, snapshot);
  assert.deepEqual(read(), ["acme/b"]);
  writeFileSync(policyPath, JSON.stringify({ revision: 1, fence: 1, repositories: ["acme/a"] }));
  assert.throws(read);
  writeFileSync(policyPath, snapshot);
  mkdirSync("/etc/unsafe-policy", { mode: 0o777 });
  chmodSync("/etc/unsafe-policy", 0o777);
  copyFileSync(policyPath, "/etc/unsafe-policy/policy.json");
  chmodSync("/etc/unsafe-policy/policy.json", 0o640);
  assert.throws(() => readRepositoryPolicy("/etc/unsafe-policy/policy.json", 0));
  observations.protectedBoundedNoSymlink = { passed: true };
  assert(commands.every((command) => !command.includes("systemctl")));
  observations.commands = commands.length;
} finally {
  active.kill("SIGTERM");
  await new Promise<void>((resolve) => active.once("exit", () => resolve()));
  observations.stopOwnsActiveTask = {
    passed: activeExit !== null || active.signalCode === "SIGTERM",
    signal: active.signalCode,
  };
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
}
