import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/db";
import { openRunnerRuntime } from "../src/runner-runtime";
import type { RunnerCommand } from "../src/runner-protocol";

test("shutdown during a cancellation acknowledgment cannot admit another pending run", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-stop-"));
  const now = Date.now();
  const paired = {
    phase: "paired" as const,
    runnerId: "runner",
    workspaceId: "workspace",
    fingerprint: "fixture",
    expiresAt: now + 3_600_000,
  };
  const commands: RunnerCommand[] = [
    {
      id: "cancel",
      type: "cancel",
      runId: "other-run",
      generation: 1,
      runnerId: "runner",
      workspaceId: "workspace",
      issuedAt: now,
      expiresAt: now + 60_000,
    },
    {
      id: "work",
      type: "run",
      runId: "live-run",
      itemId: "item",
      generation: 1,
      runnerId: "runner",
      workspaceId: "workspace",
      issuedAt: now,
      expiresAt: now + 60_000,
      repository: {
        owner: "fixture",
        repo: "repository",
        remoteUrl: "https://github.com/fixture/repository.git",
        baseSha: "a".repeat(40),
      },
      profile: { agent: "claude", model: null },
      prompt: "Implement the assigned issue",
    },
  ];
  let acknowledgeEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    acknowledgeEntered = resolve;
  });
  let releaseAcknowledgment!: () => void;
  const acknowledgment = new Promise<void>((resolve) => {
    releaseAcknowledgment = resolve;
  });
  let releaseBrokerStop!: () => void;
  const brokerStop = new Promise<void>((resolve) => {
    releaseBrokerStop = resolve;
  });
  const calls: string[] = [];
  const runtime = await openRunnerRuntime({
    root,
    repositoryRoot: join(root, "repositories"),
    home: root,
    spool: { root: join(root, "spool"), runnerUid: 1001, agentGid: 1002 },
    results: { root: join(root, "results"), agentUid: 1002, resultsGid: 1003 },
    broker: {
      async start() {
        calls.push("start");
        return { alreadyAdmitted: false };
      },
      async stop() {
        calls.push("stop");
        await brokerStop;
      },
    },
    daemon: {
      status: () => paired,
      async heartbeat() {
        return {
          leases: [{ runId: "live-run", generation: 1, expiresAt: now + 60_000 }],
          fenced: [],
        };
      },
      async pollCommands() {
        return { commands, rejected: [] };
      },
      pendingCommands: () => commands,
      async acknowledgeCommand(id) {
        calls.push(`ack:${id}`);
        if (id === "cancel") {
          acknowledgeEntered();
          await acknowledgment;
        }
      },
      async issueRunGrant() {
        calls.push("grant");
        return { token: Buffer.alloc(32, 1).toString("base64url"), expiresAt: now + 60_000 };
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
        throw new Error("Repository access must not begin after shutdown");
      },
      async renewCertificate() {
        return paired;
      },
      async uploadTranscript() {
        throw new Error("Transcript upload must not begin after shutdown");
      },
      async finishTranscript() {
        throw new Error("Transcript sealing must not begin after shutdown");
      },
      async uploadArtifact() {
        return { ok: true };
      },
    },
  });
  try {
    const ticking = runtime.tick();
    await entered;
    const stopping = runtime.stop();
    releaseAcknowledgment();
    await Promise.all([ticking, stopping]);
    const db = openDatabase(join(root, "executions.db"));
    try {
      expect(
        db.query<{ count: number }, []>("SELECT count(*) AS count FROM execution").get()!.count,
      ).toBe(0);
    } finally {
      db.close();
    }
    expect(calls).toEqual(["ack:cancel"]);
  } finally {
    releaseAcknowledgment();
    releaseBrokerStop();
    await runtime.stop();
    await Bun.sleep(0);
    rmSync(root, { recursive: true, force: true });
  }
});
