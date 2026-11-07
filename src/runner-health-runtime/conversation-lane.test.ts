import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerRequestError } from "../runner-daemon";
import type { RunnerCommand } from "../runner-protocol";
import { openRunnerHealthRuntime } from ".";

type Helper = Extract<RunnerCommand, { type: "helper" }>;

function helper(now: number, purpose: Helper["purpose"], sessionId: string): Helper {
  return {
    id: randomUUID(),
    type: "helper",
    runnerId: "runner",
    workspaceId: "workspace",
    issuedAt: now,
    expiresAt: now + (purpose === "conversation" ? 900_000 : 60_000),
    sessionId,
    sessionGeneration: 1,
    purpose,
    profile: { agent: "claude", model: null },
    prompt: "What does the acme checkout do?",
    ...(purpose === "conversation"
      ? { conversation: { itemId: "item-acme", runId: "run-acme", resumeSessionId: sessionId } }
      : {}),
  };
}

test.skipIf(process.getuid!() === 0)(
  "conversations run beside the helper slot, up to the conversation limit",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-conversation-lane-"));
    mkdirSync(join(root, "spool"), { mode: 0o750 });
    chmodSync(join(root, "spool"), 0o750);
    const now = Date.now();
    const classify = helper(now, "classify", "session-0");
    const talks = ["session-1", "session-2", "session-3"].map((id) =>
      helper(now, "conversation", id),
    );
    const pending = [classify, ...talks];
    const fenced = new Set<string>();
    const started: string[] = [];
    const runtime = await openRunnerHealthRuntime({
      root,
      now: () => now,
      conversations: () => 2,
      daemon: {
        status: () => ({
          phase: "paired",
          runnerId: "runner",
          workspaceId: "workspace",
          fingerprint: "fixture",
          expiresAt: now + 3_600_000,
        }),
        pendingCommands: () => pending,
        async pollCommands() {
          return { commands: [], rejected: [], deniedRepositories: [] };
        },
        async pollHelperCommands() {
          return { commands: pending, rejected: [], deniedRepositories: [] };
        },
        async helperLease(id) {
          if (fenced.has(id)) throw new RunnerRequestError(409);
          return { expiresAt: pending.find((command) => command.id === id)!.expiresAt };
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
      spool: {
        root: join(root, "spool"),
        runnerUid: process.getuid!(),
        agentGid: process.getgid!(),
      },
      results: {
        root: join(root, "results"),
        agentUid: process.getuid!(),
        resultsGid: process.getgid!(),
      },
      broker: {
        async start(executionId) {
          started.push(executionId);
          return { alreadyAdmitted: false };
        },
        async stop() {},
      },
    });
    const running = () => ({
      slot: runtime.status().active?.commandId,
      lane: runtime.status().conversations.map((entry) => entry.commandId),
    });
    try {
      for (let tick = 0; tick < 5; tick++) await runtime.tick();
      expect(running()).toEqual({ slot: classify.id, lane: [talks[0]!.id, talks[1]!.id] });
      expect(started).toHaveLength(3);

      fenced.add(talks[0]!.id);
      await runtime.tick();
      await runtime.tick();
      expect(running()).toEqual({ slot: classify.id, lane: [talks[1]!.id, talks[2]!.id] });
      expect(started).toHaveLength(4);
    } finally {
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
