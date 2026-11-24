import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerCommand } from "../runner-protocol";
import { openRunnerHealthRuntime } from ".";

type Helper = Extract<RunnerCommand, { type: "helper" }>;

function helper(now: number): Helper {
  return {
    id: randomUUID(),
    type: "helper",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: now,
    expiresAt: now + 180_000,
    sessionId: "slack-1",
    sessionGeneration: 1,
    purpose: "slack_reply",
    profile: { agent: "claude", model: null },
    prompt: "Which issue covers the acme checkout?",
    slack: {
      requestId: "slack-1",
      teamId: "T0ACME",
      channelId: "C0GENERAL",
      threadTs: "1795053091.151000",
      memberUserId: "member",
      installGeneration: 1,
    },
  };
}

test("a command that fails to start reports the failed check until one starts", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-health-report-"));
  mkdirSync(join(root, "spool"), { mode: 0o750 });
  chmodSync(join(root, "spool"), 0o750);
  mkdirSync(join(root, "results"), { mode: 0o770 });
  chmodSync(join(root, "results"), 0o770);
  chmodSync(root, 0o700);
  const now = Date.now();
  const commands = [helper(now)];
  const reports: (string | undefined)[] = [];
  let refuse = true;
  const runtime = await openRunnerHealthRuntime({
    root,
    conversations: () => 1,
    onHealth: (failure) => reports.push(failure),
    daemon: {
      status: () => ({
        phase: "paired",
        runnerId: "runner",
        workspaceId: "workspace",
        fingerprint: "fixture",
        expiresAt: now + 3_600_000,
      }),
      pendingCommands: () => commands,
      async pollCommands() {
        return { commands: [], rejected: [], deniedRepositories: [] };
      },
      async pollHelperCommands() {
        return { commands, rejected: [], deniedRepositories: [] };
      },
      async helperLease() {
        return { expiresAt: now + 180_000 };
      },
      async acknowledgeCommand() {},
      async postHelperResult() {
        return { duplicate: false };
      },
      async postHealth() {
        throw new Error("Helpers do not post health");
      },
      async heartbeat() {
        throw new Error("Helpers do not use run heartbeats");
      },
    },
    spool: { root: join(root, "spool"), runnerUid: process.getuid!(), agentGid: process.getgid!() },
    results: {
      root: join(root, "results"),
      agentUid: process.getuid!(),
      resultsGid: process.getgid!(),
    },
    broker: {
      async start() {
        if (refuse)
          throw new Error("EACCES: permission denied, lstat '/var/lib/paws-agent/.local/share'");
        return { alreadyAdmitted: false };
      },
      async stop() {},
    },
  });
  try {
    await runtime.tick();
    expect(reports).toEqual([
      "EACCES: permission denied, lstat '/var/lib/paws-agent/.local/share'",
    ]);
    refuse = false;
    commands.push(helper(now));
    await runtime.tick();
    expect(reports.at(-1)).toBeUndefined();
    expect(runtime.status().conversations).toHaveLength(1);
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
