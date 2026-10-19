import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRunnerRuntime } from "../src/runner-runtime";
import type { RunnerCommand } from "../src/runner-protocol";

test("a worker that dies without a result is resumed at most twice", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-resume-"));
  const now = Date.now();
  const spool = {
    root: join(root, "spool"),
    runnerUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
  mkdirSync(spool.root);
  chmodSync(spool.root, 0o750);
  const command: RunnerCommand = {
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
    expiresAt: now + 60_000,
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
  const calls: string[] = [];
  let alive = true;
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
    broker: {
      async start(id) {
        calls.push(`start:${id}`);
        return { alreadyAdmitted: false };
      },
      async stop(id) {
        calls.push(`stop:${id}`);
      },
      alive: () => alive,
      async resume(id) {
        calls.push(`resume:${id}`);
      },
    },
    daemon: {
      status: () => paired,
      async heartbeat() {
        return { leases: [{ runId: "run", generation: 1, expiresAt: now + 60_000 }], fenced: [] };
      },
      async pollCommands() {
        return { commands: [command], rejected: [], deniedRepositories: [] };
      },
      pendingCommands: () => [command],
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
      async postResult() {
        return { duplicate: false };
      },
      async repositoryCredential() {
        throw new Error("unused");
      },
      async renewCertificate() {
        return paired;
      },
      async uploadArtifact() {
        return { ok: true };
      },
      async uploadTranscript() {
        return { ok: true };
      },
      async finishTranscript() {
        return { ok: true };
      },
    },
  });
  try {
    await runtime.tick();
    for (let i = 0; i < 200 && !calls.some((call) => call.startsWith("start:")); i++)
      await Bun.sleep(5);
    const execution = calls.find((call) => call.startsWith("start:"))!.slice(6);
    await runtime.tick();
    expect(calls.filter((call) => call.startsWith("resume:"))).toEqual([]);
    alive = false;
    for (let i = 0; i < 4; i++) await runtime.tick();
    expect(calls.filter((call) => call.startsWith("resume:"))).toEqual([
      `resume:${execution}`,
      `resume:${execution}`,
    ]);
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
