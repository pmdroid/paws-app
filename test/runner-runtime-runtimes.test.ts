import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRunnerJob } from "../src/runner-execution";
import { openRunnerRuntime } from "../src/runner-runtime";
import type { RunnerCommand, RunnerInstalledRuntime } from "../src/runner-protocol";

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "the runtimes a worker installed go out with the next heartbeat and after a restart",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-runtime-runtimes-"));
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
    const failure = "Paws could not install the runtime python@3.99: mise exited with code 1.";
    const report: RunnerInstalledRuntime[] = [
      { tool: "node", version: "22", status: "installed" },
      { tool: "python", version: "3.99", status: "failed", error: failure },
    ];
    const paired = {
      phase: "paired" as const,
      runnerId: "runner",
      workspaceId: "workspace",
      fingerprint: "fixture",
      expiresAt: now + 3_600_000,
    };
    let pending: RunnerCommand[] = [
      {
        id: "command-run",
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
        runtimes: [
          { tool: "node", version: "22" },
          { tool: "python", version: "3.99" },
        ],
      },
    ];
    const heartbeats: (readonly RunnerInstalledRuntime[] | undefined)[] = [];
    let posted = 0;
    const daemon = {
      status: () => paired,
      async heartbeat(_skills?: unknown, runtimes?: readonly RunnerInstalledRuntime[]) {
        heartbeats.push(runtimes);
        return {
          leases: [{ runId: "run", generation: 1, expiresAt: now + 60_000 }],
          fenced: [],
        };
      },
      async pollCommands() {
        return { commands: pending, rejected: [], deniedRepositories: [] };
      },
      pendingCommands: () => pending,
      async acknowledgeCommand(id: string) {
        pending = pending.filter((command) => command.id !== id);
      },
      async issueRunGrant() {
        return { token: "token", expiresAt: now + 60_000 };
      },
      async sendEvent() {
        return { duplicate: false as const };
      },
      async answers() {
        return { answers: [] };
      },
      async postResult() {
        posted += 1;
        return { duplicate: false as const };
      },
      async repositoryCredential(): Promise<never> {
        throw new Error("Repository-free task");
      },
      async renewCertificate() {
        return paired;
      },
      async uploadArtifact() {
        return { ok: true as const };
      },
      async uploadTranscript(_runId: string, chunk: { offset: number }) {
        return { offset: chunk.offset, duplicate: false };
      },
      async finishTranscript() {
        return { uri: "transcript" };
      },
    };
    const open = () =>
      openRunnerRuntime({
        root,
        spool,
        results,
        repositoryRoot: join(root, "repositories"),
        home: root,
        broker: {
          async start(id) {
            const command = readRunnerJob(spool, id).command;
            if (command.type !== "task") throw new Error("Unexpected command");
            const directory = join(results.root, id);
            mkdirSync(directory);
            chmodSync(directory, 0o750);
            for (const [name, body] of [
              ["events.jsonl", ""],
              ["runtimes.json", JSON.stringify(report)],
              [
                "result.json",
                JSON.stringify({
                  executionId: id,
                  commandId: command.id,
                  run: {
                    role: "implementer",
                    stopReason: "error",
                    errorMessage: failure,
                    timedOut: false,
                    cancelled: false,
                    authRequired: false,
                    agentExited: false,
                  },
                }),
              ],
            ] as const) {
              writeFileSync(join(directory, name), body);
              chmodSync(join(directory, name), 0o640);
            }
            return { alreadyAdmitted: false };
          },
          async stop() {},
          alive: () => true,
        },
        daemon,
      });
    const runtime = await open();
    try {
      for (let tries = 0; tries < 200; tries += 1) {
        if (posted > 0) break;
        await runtime.tick();
        await Bun.sleep(1);
      }
      expect(posted).toBe(1);
      expect(heartbeats[0]).toEqual([]);
      await runtime.tick();
      expect(heartbeats.at(-1)).toEqual(report);
    } finally {
      await runtime.stop();
    }
    const restarted = await open();
    try {
      await restarted.tick();
      expect(heartbeats.at(-1)).toEqual(report);
    } finally {
      await restarted.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
