import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_DOCKER_SOCKET,
  agentDockerEnv,
  RUNNER_DOCKER_SOCKET,
  runnerDockerEnv,
  type RunnerJob,
} from "../src/runner-execution";
import { executeRunnerCommand } from "../src/runner-worker";

const roots: string[] = [];
const inherited = process.env.DOCKER_HOST;
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (inherited === undefined) delete process.env.DOCKER_HOST;
  else process.env.DOCKER_HOST = inherited;
});
function temporary(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

test("workers get DOCKER_HOST only when the rootless Docker socket exists", async () => {
  expect(RUNNER_DOCKER_SOCKET).toBe("/run/paws-docker/docker.sock");
  const root = temporary("paws-docker-socket-");
  const socket = join(root, "docker.sock");
  expect(runnerDockerEnv(socket)).toEqual({});
  writeFileSync(socket, "not a socket");
  expect(runnerDockerEnv(socket)).toEqual({});
  rmSync(socket);
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    expect(runnerDockerEnv(socket)).toEqual({ DOCKER_HOST: `unix://${socket}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("paws-agent executions get their own daemon's socket while its runtime directory exists", () => {
  expect(AGENT_DOCKER_SOCKET).toBe("/run/paws-agent-docker/docker.sock");
  const root = temporary("paws-agent-docker-");
  // paws-runner cannot enter paws-agent's runtime directory, so only the directory is looked at.
  const socket = join(root, "paws-agent-docker", "docker.sock");
  expect(agentDockerEnv(socket)).toEqual({});
  writeFileSync(join(root, "paws-agent-docker"), "not a directory");
  expect(agentDockerEnv(socket)).toEqual({});
  rmSync(join(root, "paws-agent-docker"));
  mkdirSync(join(root, "paws-agent-docker"), { mode: 0o700 });
  expect(agentDockerEnv(socket)).toEqual({ DOCKER_HOST: `unix://${socket}` });
});

test("the agent inherits the worker's local DOCKER_HOST and never a remote one", async () => {
  const seen: (string | undefined)[] = [];
  for (const value of ["unix:///run/paws-docker/docker.sock", "tcp://docker.example.test:2376"]) {
    process.env.DOCKER_HOST = value;
    const root = temporary("paws-docker-worker-");
    const outputDirectory = join(root, "output");
    const work = join(root, "work");
    mkdirSync(outputDirectory);
    mkdirSync(work);
    const job: RunnerJob = {
      executionId: "01J00000000000000000000001",
      command: {
        id: "check",
        runnerId: "runner",
        workspaceId: "workspace",
        issuedAt: 1,
        expiresAt: Date.now() + 60_000,
        type: "login_check",
        agent: "codex",
      },
    };
    const script = join(root, "script.json");
    writeFileSync(script, JSON.stringify({ model: "fixture-model", steps: [{ type: "hang" }] }));
    const fake = new URL("../src/acp/testing/fake-agent.ts", import.meta.url).pathname;
    await executeRunnerCommand({
      job,
      outputDirectory,
      workRoot: work,
      home: root,
      resultsGid: process.getgid!(),
      launch: { command: process.execPath, args: [fake, join(root, "trace.json"), script] },
      loginCommand: async (_command, _args, env) => {
        seen.push(env.DOCKER_HOST);
        return { exitCode: 0, stdout: "Logged in", stderr: "" };
      },
      codexRateLimits: async () => ({ rateLimits: {} }),
    });
  }
  expect(seen).toEqual(["unix:///run/paws-docker/docker.sock", undefined]);
}, 30_000);
