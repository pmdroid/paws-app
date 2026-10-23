import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRunnerJob } from "../src/runner-execution";
import { openRunnerRuntime } from "../src/runner-runtime";
import type { RunnerCommand, RunnerResult } from "../src/runner-protocol";

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await Bun.sleep(5);
}

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a held answer request for one execution leaves the other execution and cancellations moving",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-runtime-delivery-"));
    const now = Date.now();
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
    for (const directory of [spool.root, results.root]) {
      mkdirSync(directory);
      chmodSync(directory, 0o750);
    }
    const task = (runId: string): RunnerCommand => ({
      id: `command-${runId}`,
      type: "task",
      runnerId: "runner",
      workspaceId: "workspace",
      runId,
      itemId: `item-${runId}`,
      generation: 1,
      sessionId: `session-${runId}`,
      sessionGeneration: 1,
      taskModeGeneration: 1,
      purpose: "answer",
      issuedAt: now,
      expiresAt: now + 600_000,
      profile: { agent: "claude", model: null },
      prompt: "signed prompt",
    });
    const paired = {
      phase: "paired" as const,
      runnerId: "runner",
      workspaceId: "workspace",
      fingerprint: "fixture",
      expiresAt: now + 3_600_000,
    };
    let pending: RunnerCommand[] = [task("run-a"), task("run-b")];
    const executions = new Map<string, string>();
    const held = Promise.withResolvers<{ answers: [] }>();
    const answered: string[] = [];
    const acknowledged: string[] = [];
    const stopped: string[] = [];
    const posted: { runId: string; result: RunnerResult }[] = [];
    const runtime = await openRunnerRuntime({
      root,
      spool,
      results,
      concurrency: 2,
      repositoryRoot: join(root, "repositories"),
      home: root,
      broker: {
        async start(id) {
          const command = readRunnerJob(spool, id).command;
          if (command.type !== "task") throw new Error("Unexpected command");
          executions.set(command.runId, id);
          const directory = join(results.root, id);
          mkdirSync(directory);
          chmodSync(directory, 0o750);
          for (const [name, body] of [
            ["events.jsonl", ""],
            [
              "result.json",
              JSON.stringify({
                executionId: id,
                commandId: command.id,
                run: {
                  role: "implementer",
                  stopReason: "end_turn",
                  timedOut: false,
                  cancelled: false,
                  authRequired: false,
                  agentExited: true,
                },
              }),
            ],
          ] as const) {
            writeFileSync(join(directory, name), body);
            chmodSync(join(directory, name), 0o640);
          }
          return { alreadyAdmitted: false };
        },
        async stop(id) {
          stopped.push(id);
        },
        alive: () => true,
      },
      daemon: {
        status: () => paired,
        async heartbeat() {
          return {
            leases: ["run-a", "run-b"].map((runId) => ({
              runId,
              generation: 1,
              expiresAt: now + 60_000,
            })),
            fenced: [],
          };
        },
        async pollCommands() {
          return { commands: pending, rejected: [], deniedRepositories: [] };
        },
        pendingCommands: () => pending,
        async acknowledgeCommand(id) {
          acknowledged.push(id);
          pending = pending.filter((command) => command.id !== id);
        },
        async issueRunGrant() {
          return { token: "token", expiresAt: now + 60_000 };
        },
        async sendEvent() {
          return { duplicate: false };
        },
        async answers(runId) {
          answered.push(runId);
          return runId === "run-a" ? held.promise : { answers: [] };
        },
        async postResult(runId, _generation, result) {
          posted.push({ runId, result });
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
    try {
      await Promise.race([runtime.tick(), Bun.sleep(50)]);
      await until(() => executions.size === 2);
      for (let i = 0; i < 20 && !posted.length; i++)
        await Promise.race([runtime.tick(), Bun.sleep(50)]);
      expect(posted.map((entry) => entry.runId)).toEqual(["run-b"]);
      expect(answered.filter((runId) => runId === "run-a")).toEqual(["run-a"]);
      pending = [
        {
          id: "cancel-a",
          type: "cancel",
          runId: "run-a",
          generation: 1,
          runnerId: "runner",
          workspaceId: "workspace",
          issuedAt: now,
          expiresAt: now + 60_000,
        },
      ];
      for (let i = 0; i < 20 && !acknowledged.includes("cancel-a"); i++)
        await Promise.race([runtime.tick(), Bun.sleep(50)]);
      expect(acknowledged).toContain("cancel-a");
      expect(stopped).toContain(executions.get("run-a")!);
      expect(answered.filter((runId) => runId === "run-a")).toEqual(["run-a"]);
      held.resolve({ answers: [] });
      await runtime.tick();
      await Bun.sleep(20);
      expect(posted.map((entry) => entry.runId)).toEqual(["run-b"]);
      expect(posted[0]!.result.executionId).toBe(executions.get("run-b")!);
    } finally {
      held.resolve({ answers: [] });
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
