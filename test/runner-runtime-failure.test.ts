import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRunnerRuntime } from "../src/runner-runtime";
import type { RunnerCommand, RunnerResult } from "../src/runner-protocol";

async function fixture(options: { alive?: boolean; cancel?: boolean } = {}) {
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
  const command: Extract<RunnerCommand, { type: "task" }> = {
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
    issuedAt: now,
    expiresAt: now + 600_000,
    profile: { agent: "claude", model: null },
    prompt: "signed prompt",
  };
  const paired = {
    phase: "paired" as const,
    runnerId: "runner",
    workspaceId: "workspace",
    fingerprint: "fixture",
    expiresAt: now + 3_600_000,
  };
  const commands: RunnerCommand[] = [command];
  const results: RunnerResult[] = [];
  const errors: string[] = [];
  const starts: string[] = [];
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
    broker: {
      async start(id) {
        starts.push(id);
        return { alreadyAdmitted: false };
      },
      async stop() {},
      alive: () => options.alive ?? true,
      log: () => "worker output line\nTypeError: boom",
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
        throw new Error("Repository-free task");
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
  for (let i = 0; i < 200 && !starts.length; i++) await Bun.sleep(1);
  return {
    runtime,
    results,
    errors,
    commands,
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

test("a lease watchdog interrupt reports a failure with its reason", async () => {
  const f = await fixture();
  try {
    f.advance(120_000);
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
