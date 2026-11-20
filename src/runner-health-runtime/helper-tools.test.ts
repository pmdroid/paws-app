import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readRunnerAnswer } from "../runner-answers";
import { RunnerRequestError } from "../runner-daemon";
import { createRunnerResultDirectory } from "../runner-execution";
import type { RunnerCommand } from "../runner-protocol";
import { openRunnerHealthRuntime } from ".";

type Helper = Extract<RunnerCommand, { type: "helper" }>;

function slackReply(now: number, tools: boolean): Helper {
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
    ...(tools
      ? { tools: [{ name: "linear_issue", description: "Read an issue.", inputSchema: {} }] }
      : {}),
  };
}

async function open(tools: boolean, answer: (requestId: string) => Promise<{ text: string }>) {
  const root = mkdtempSync(join(tmpdir(), "paws-helper-tools-"));
  mkdirSync(join(root, "spool"), { mode: 0o750 });
  chmodSync(join(root, "spool"), 0o750);
  mkdirSync(join(root, "results"), { mode: 0o770 });
  chmodSync(join(root, "results"), 0o770);
  const now = Date.now();
  const command = slackReply(now, tools);
  const requests: { id: string; requestId: string; name: string }[] = [];
  const spool = {
    root: join(root, "spool"),
    runnerUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
  const results = {
    root: join(root, "results"),
    agentUid: process.getuid!(),
    resultsGid: process.getgid!(),
  };
  const runtime = await openRunnerHealthRuntime({
    root,
    conversations: () => 1,
    daemon: {
      status: () => ({
        phase: "paired",
        runnerId: "runner",
        workspaceId: "workspace",
        fingerprint: "fixture",
        expiresAt: now + 3_600_000,
      }),
      pendingCommands: () => [command],
      async pollCommands() {
        return { commands: [], rejected: [], deniedRepositories: [] };
      },
      async pollHelperCommands() {
        return { commands: [command], rejected: [], deniedRepositories: [] };
      },
      async helperLease() {
        return { expiresAt: command.expiresAt };
      },
      async helperRequest(id, request) {
        requests.push({ id, requestId: request.requestId, name: request.name });
        return answer(request.requestId);
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
    spool,
    results,
    broker: {
      async start() {
        return { alreadyAdmitted: false };
      },
      async stop() {},
    },
  });
  await runtime.tick();
  const executionId = runtime.status().conversations[0]!.executionId;
  const events = join(createRunnerResultDirectory(results, executionId), "events.jsonl");
  writeFileSync(events, "", { mode: 0o640 });
  chmodSync(events, 0o640);
  return {
    command,
    requests,
    ask(requestId: string) {
      appendFileSync(
        events,
        `${JSON.stringify({ type: "tool", requestId, name: "linear_issue", arguments: { id: "PAS-1" }, t: new Date().toISOString() })}\n`,
      );
    },
    async answer(requestId: string, wait = 2_000) {
      for (let waited = 0; waited < wait; waited += 50) {
        const published = readRunnerAnswer(spool, executionId, requestId);
        if (published) return JSON.parse(published.answer) as unknown;
        await delay(50);
      }
      return null;
    },
    async close() {
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test.skipIf(process.getuid!() === 0)(
  "a Slack reply helper forwards each tool request once and answers the agent",
  async () => {
    const [answered, fenced, offline] = [randomUUID(), randomUUID(), randomUUID()];
    const runtime = await open(true, async (requestId) => {
      if (requestId === fenced) throw new RunnerRequestError(409);
      if (requestId === offline) throw new Error("socket hang up");
      return { text: "PAS-1: Fix rounding" };
    });
    try {
      runtime.ask(answered);
      expect(await runtime.answer(answered)).toEqual({ text: "PAS-1: Fix rounding" });
      await delay(600);
      expect(runtime.requests).toEqual([
        { id: runtime.command.id, requestId: answered, name: "linear_issue" },
      ]);

      runtime.ask(fenced);
      const unanswered = { text: "Paws could not answer that tool.", isError: true };
      expect(await runtime.answer(fenced)).toEqual(unanswered);
      runtime.ask(offline);
      expect(await runtime.answer(offline)).toEqual(unanswered);
      await delay(600);
      expect(runtime.requests.map((request) => request.requestId)).toEqual([
        answered,
        fenced,
        offline,
        offline,
      ]);
    } finally {
      await runtime.close();
    }
  },
);

test.skipIf(process.getuid!() === 0)("a helper without tools reads no tool events", async () => {
  const runtime = await open(false, async () => ({ text: "unused" }));
  try {
    const requestId = randomUUID();
    runtime.ask(requestId);
    expect(await runtime.answer(requestId, 600)).toBeNull();
    expect(runtime.requests).toEqual([]);
  } finally {
    await runtime.close();
  }
});
