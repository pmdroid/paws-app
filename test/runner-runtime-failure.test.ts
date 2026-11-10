import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRunnerRuntime } from "../src/runner-runtime";
import {
  RUNNER_LEASE_GRACE_MS,
  type RunnerCommand,
  type RunnerResult,
} from "../src/runner-protocol";

async function fixture(
  options: {
    alive?: boolean;
    cancel?: boolean;
    log?: string;
    phase?: string;
    exit?: string;
    gitError?: string;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-failure-"));
  const now = Date.now();
  let clock = 0;
  const spool = {
    root: join(root, "spool"),
    runnerUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
  mkdirSync(spool.root);
  chmodSync(spool.root, 0o750);
  const shared = {
    id: "command",
    runnerId: "runner",
    workspaceId: "workspace",
    runId: "run",
    itemId: "item",
    generation: 1,
    issuedAt: now,
    expiresAt: now + 600_000,
    profile: { agent: "claude" as const, model: null },
    prompt: "signed prompt",
  };
  const command: Extract<RunnerCommand, { type: "task" }> = {
    ...shared,
    type: "task",
    sessionId: "session",
    sessionGeneration: 1,
    taskModeGeneration: 1,
    purpose: "answer",
  };
  const paired = {
    phase: "paired" as const,
    runnerId: "runner",
    workspaceId: "workspace",
    fingerprint: "fixture",
    expiresAt: now + 3_600_000,
  };
  const repository = {
    owner: "acme",
    repo: "widgets",
    remoteUrl: "https://github.com/acme/widgets.git",
    baseSha: "a".repeat(40),
  };
  const commands: RunnerCommand[] = [
    options.gitError ? { ...shared, type: "run", repository } : command,
  ];
  const results: RunnerResult[] = [];
  const errors: string[] = [];
  const starts: string[] = [];
  let gitCalls = 0;
  const runtime = await openRunnerRuntime({
    root,
    spool,
    results: {
      root: join(root, "results"),
      agentUid: process.getuid!(),
      resultsGid: process.getgid!(),
    },
    repositoryRoot: join(root, "repositories"),
    home: root,
    now: () => now,
    monotonic: () => clock,
    onError: (error) => errors.push(error.message),
    ...(options.gitError
      ? {
          async networkGit() {
            gitCalls++;
            throw new Error(options.gitError);
          },
        }
      : {}),
    broker: {
      async start(id) {
        if (options.phase) {
          mkdirSync(join(root, "results", id), { recursive: true, mode: 0o750 });
          chmodSync(join(root, "results"), 0o770);
          writeFileSync(join(root, "results", id, "phase.txt"), options.phase, { mode: 0o640 });
        }
        starts.push(id);
        return { alreadyAdmitted: false };
      },
      async stop() {},
      alive: () => options.alive ?? true,
      exitStatus: async () => options.exit,
      log: () => options.log ?? "worker output line\nTypeError: boom",
    },
    daemon: {
      status: () => paired,
      async heartbeat() {
        return { leases: [{ runId: "run", generation: 1, expiresAt: now + 60_000 }], fenced: [] };
      },
      async pollCommands() {
        return { commands, rejected: [], deniedRepositories: [] };
      },
      pendingCommands: () => commands,
      async acknowledgeCommand() {},
      async issueRunGrant() {
        return { token: "token", expiresAt: now + 60_000 };
      },
      async sendEvent() {
        return { duplicate: false };
      },
      async answers() {
        return { answers: [] };
      },
      async postResult(_runId, _generation, result) {
        results.push(result);
        return { duplicate: false };
      },
      async repositoryCredential() {
        if (!options.gitError) throw new Error("Repository-free task");
        return {
          token: "token",
          expiresAt: now + 60_000,
          remoteUrl: repository.remoteUrl,
          branch: null,
        };
      },
      async renewCertificate() {
        return paired;
      },
      async uploadArtifact() {
        return { ok: true };
      },
      async uploadTranscript(_runId, chunk) {
        return { offset: chunk.offset, duplicate: false };
      },
      async finishTranscript() {
        return { uri: "transcript" };
      },
    },
  });
  await runtime.tick();
  const launched = () => starts.length > 0 || gitCalls > 0;
  for (let i = 0; i < 200 && !launched(); i++) await Bun.sleep(1);
  return {
    runtime,
    results,
    errors,
    commands,
    gitCalls: () => gitCalls,
    advance: (ms: number) => {
      clock += ms;
    },
    cleanup: async () => {
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5);
}

test("a worker that exits without a result reports a failure with its log tail", async () => {
  const f = await fixture({ alive: false });
  try {
    await f.runtime.tick();
    await until(() => f.results.length > 0);
    expect(f.results).toHaveLength(1);
    expect(f.results[0]!.stopReason).toBe("error");
    expect(f.results[0]!.errorMessage).toContain("worker exited without a result");
    expect(f.results[0]!.errorMessage).toContain("TypeError: boom");
    expect(f.errors.join("\n")).toContain("worker exited without a result");
  } finally {
    await f.cleanup();
  }
});

test("a launch that fails on a git error reports a run failure within one tick", async () => {
  const gitError = [
    "From /tmp/paws-publication-x/repo",
    " - [deleted] (none) -> test/timeout-fix",
    "fatal: could not fetch 914306a from promisor remote",
  ].join("\n");
  const f = await fixture({ gitError });
  try {
    await until(() => f.results.length > 0);
    expect(f.results).toHaveLength(1);
    expect(f.results[0]!.stopReason).toBe("error");
    expect(f.results[0]!.errorMessage).toContain("could not fetch 914306a from promisor remote");
    expect(f.gitCalls()).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test.each([
  ["a lost connection", "fatal: unable to access: Could not resolve host: github.com"],
  ["a failed request outside git", "fetch failed"],
])("a launch that hits %s keeps retrying", async (_name, gitError) => {
  const f = await fixture({ gitError });
  try {
    await until(() => f.gitCalls() > 0);
    await Bun.sleep(20);
    await f.runtime.tick();
    await until(() => f.gitCalls() > 1);
    expect(f.gitCalls()).toBeGreaterThan(1);
    expect(f.results).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test("a lease watchdog interrupt reports a failure with its reason", async () => {
  const f = await fixture();
  try {
    f.advance(60_000 + RUNNER_LEASE_GRACE_MS);
    await until(() => f.results.length > 0);
    expect(f.results).toHaveLength(1);
    expect(f.results[0]!.errorMessage).toContain("lease deadline passed");
    expect(f.errors.join("\n")).toContain("lease deadline passed");
  } finally {
    await f.cleanup();
  }
});

test("a cancel from Paws stops the worker without reporting a failure", async () => {
  const f = await fixture();
  try {
    f.commands.push({
      id: "cancel",
      type: "cancel",
      runId: "run",
      generation: 1,
      runnerId: "runner",
      workspaceId: "workspace",
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    await f.runtime.tick();
    await Bun.sleep(100);
    expect(f.results).toHaveLength(0);
    expect(f.errors.join("\n")).toContain("cancelled by Paws");
  } finally {
    await f.cleanup();
  }
});

test("a missing result reports the exit code and last worker phase", async () => {
  const f = await fixture({
    alive: false,
    log: '{"event":"worker_phase","phase":"checkout"}\n{"event":"worker_phase","phase":"agent"}\nRunner worker exited with code 1\n',
  });
  try {
    await f.runtime.tick();
    await until(() => f.results.length > 0);
    expect(f.results[0]!.errorMessage).toContain("worker exited with code 1 during phase agent");
  } finally {
    await f.cleanup();
  }
});

test("persisted phase and unit exit status survive verbose worker output", async () => {
  const f = await fixture({
    alive: false,
    phase: "agent",
    exit: "signal 9",
    log: "verbose output\n".repeat(500),
  });
  try {
    await f.runtime.tick();
    await until(() => f.results.length > 0);
    expect(f.results[0]!.errorMessage).toContain("worker exited with signal 9 during phase agent");
  } finally {
    await f.cleanup();
  }
});
