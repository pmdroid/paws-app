import { generateKeyPairSync } from "node:crypto";
import { RunnerRequestError } from "../src/runner-daemon";
import { runnerVerifierFingerprint } from "../src/runner-verifier";
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/db";
import { openRunnerCheckRuntime } from "../src/runner-check-runtime";
import type { RunnerCommand } from "../src/runner-protocol";

test.each([
  {
    name: "shutdown during a cancellation acknowledgment cannot admit another pending trusted check",
    mode: "shutdown",
  },
  {
    name: "transient trusted-check grants retry while admitted work remains leased",
    mode: "retry",
  },
] as const)("$name", async ({ mode }) => {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-stop-"));
  const now = Date.now();
  let wallClock = now;
  const verifierPublicKeyPem = generateKeyPairSync("ed25519")
    .publicKey.export({ type: "spki", format: "pem" })
    .toString();
  const paired = {
    verifierFingerprint: runnerVerifierFingerprint(verifierPublicKeyPem),
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
      type: "check",
      executionId: "01K00000000000000000000001",
      verificationAttemptId: "01K00000000000000000000002",
      candidateSha: "a".repeat(40),
      argv: ["/usr/bin/true"],
      cwd: ".",
      timeoutMs: 1000,
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
  const runtime = await openRunnerCheckRuntime({
    root,
    repositoryRoot: join(root, "repositories"),
    home: root,
    verifierPublicKeyPem,
    now: () => wallClock,
    paths: {
      inputRoot: join(root, "input"),
      workRoot: join(root, "work"),
      resultRoot: join(root, "results"),
      runnerUid: 1001,
      runnerGid: 1001,
      inputGid: 1003,
      checkUid: 1002,
      checkGid: 1002,
    },
    broker: {
      async startCheck() {
        calls.push("start");
        return { alreadyAdmitted: false };
      },
      async stopCheck() {
        calls.push("stop");
        if (mode === "shutdown") await brokerStop;
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
      pendingCommands: () => (mode === "retry" ? commands.slice(1) : commands),
      async acknowledgeCommand(id) {
        calls.push(`ack:${id}`);
        if (id === "cancel") {
          acknowledgeEntered();
          await acknowledgment;
        }
      },
      async issueRunGrant() {
        calls.push("grant");
        if (mode === "retry") throw new RunnerRequestError(503);
        return { token: Buffer.alloc(32, 1).toString("base64url"), expiresAt: now + 60_000 };
      },
      async postCheckResult() {
        return { duplicate: false };
      },
      async repositoryCredential() {
        throw new Error("Repository access must not begin after shutdown");
      },
    },
  });
  try {
    if (mode === "retry") {
      await runtime.tick();
      await Bun.sleep(0);
      expect(runtime.status().active?.phase).toBe("preparing");
      await runtime.tick();
      await Bun.sleep(0);
      expect(calls.filter((call) => call === "grant").length).toBe(2);
      wallClock = now + 60_001;
      await runtime.tick();
      await Bun.sleep(0);
      await runtime.tick();
      expect(runtime.status().active).toBe(null);
      const db = openDatabase(join(root, "checks.db"));
      try {
        expect(
          db.query<{ phase: string }, []>("SELECT phase FROM check_execution").get()!.phase,
        ).toBe("interrupted");
      } finally {
        db.close();
      }
      expect(calls).not.toContain("start");
      return;
    }
    const ticking = runtime.tick();
    await entered;
    const stopping = runtime.stop();
    releaseAcknowledgment();
    await Promise.all([ticking, stopping]);
    const db = openDatabase(join(root, "checks.db"));
    try {
      expect(
        db.query<{ count: number }, []>("SELECT count(*) AS count FROM check_execution").get()!
          .count,
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
