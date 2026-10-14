import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../src/db";
import { readRunnerJob } from "../../src/runner-execution";
import { openRunnerRuntime } from "../../src/runner-runtime";
import type { RunnerCommand } from "../../src/runner-protocol";

export async function probeParallelRuntime(root: string) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const observations = [];
  for (const concurrency of [1, 2, 4]) {
    const home = join(root, String(concurrency));
    mkdirSync(home, { mode: 0o700 });
    const spool = {
      root: join(home, "spool"),
      runnerUid: process.getuid!(),
      agentGid: process.getgid!(),
    };
    mkdirSync(spool.root, { mode: 0o750 });
    chmodSync(spool.root, 0o750);
    const now = Date.now();
    const paired = {
      phase: "paired" as const,
      runnerId: "runner",
      workspaceId: "workspace",
      fingerprint: "fixture",
      expiresAt: now + 3_600_000,
    };
    const commands: RunnerCommand[] = Array.from({ length: concurrency + 1 }, (_, i) => ({
      id: `command-${i}`,
      type: "task",
      runId: `run-${i}`,
      itemId: `item-${i}`,
      generation: 1,
      runnerId: "runner",
      workspaceId: "workspace",
      issuedAt: now,
      expiresAt: now + 60_000,
      sessionId: `session-${i}`,
      sessionGeneration: 0,
      taskModeGeneration: 0,
      purpose: "answer",
      profile: { agent: "claude", model: null },
      prompt: `Independent request ${i}`,
    }));
    let pending = [...commands];
    const starts = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
    const stopped: string[] = [];
    const runtime = await openRunnerRuntime({
      root: home,
      repositoryRoot: join(home, "repositories"),
      home,
      spool,
      concurrency,
      results: {
        root: join(home, "results"),
        agentUid: process.getuid!(),
        resultsGid: process.getgid!(),
      },
      broker: {
        async start(id) {
          const barrier = Promise.withResolvers<void>();
          starts.set(id, barrier);
          await barrier.promise;
          return { alreadyAdmitted: false };
        },
        async stop(id) {
          stopped.push(id);
        },
      },
      daemon: {
        status: () => paired,
        async heartbeat() {
          return {
            leases: commands.map((command) => ({
              runId: "runId" in command ? command.runId : "",
              generation: 1,
              expiresAt: now + 60_000,
            })),
            fenced: [],
          };
        },
        async pollCommands() {
          return { commands: pending, rejected: [] };
        },
        pendingCommands: () => pending,
        async acknowledgeCommand(id) {
          pending = pending.filter((command) => command.id !== id);
        },
        async issueRunGrant() {
          return { token: Buffer.alloc(32, 1).toString("base64url"), expiresAt: now + 60_000 };
        },
        async sendEvent() {
          throw new Error("A held worker cannot publish events");
        },
        async answers() {
          return { answers: [] };
        },
        async postResult() {
          throw new Error("A held worker cannot complete");
        },
        async repositoryCredential() {
          throw new Error("An independent answer needs no repository");
        },
        async renewCertificate() {
          return paired;
        },
        async uploadTranscript() {
          throw new Error("A held worker has no transcript");
        },
        async finishTranscript() {
          throw new Error("A held worker has no transcript");
        },
        async uploadArtifact() {
          throw new Error("A held worker has no artifact");
        },
      },
    });
    try {
      await runtime.tick();
      for (let i = 0; starts.size < concurrency && i < 100; i++) await Bun.sleep(1);
      assert.equal(starts.size, concurrency);
      assert.equal(pending.length, 1);
      const paths = readdirSync(spool.root);
      assert.equal(paths.length, concurrency);
      const runIds = paths.map((id) => {
        const command = readRunnerJob(spool, id).command;
        assert.equal(command.type, "task");
        return "runId" in command ? command.runId : "";
      });
      assert.equal(new Set(runIds).size, concurrency);
      const [firstId, barrier] = [...starts.entries()][0]!;
      const command = readRunnerJob(spool, firstId).command;
      assert("runId" in command && "generation" in command);
      pending.unshift({
        ...command,
        id: "cancel-first",
        type: "cancel",
        runId: command.runId,
        generation: command.generation,
      });
      barrier.resolve();
      await runtime.tick();
      for (let i = 0; starts.size < concurrency + 1 && i < 100; i++) await Bun.sleep(1);
      assert.equal(starts.size, concurrency + 1);
      assert.deepEqual(stopped, [firstId]);
      const db = openDatabase(join(home, "executions.db"));
      try {
        assert.equal(
          (
            db.query("SELECT count(*) AS n FROM execution WHERE phase='interrupted'").get() as {
              n: number;
            }
          ).n,
          1,
        );
        assert.equal(
          (
            db.query("SELECT count(*) AS n FROM execution WHERE phase='preparing'").get() as {
              n: number;
            }
          ).n,
          concurrency,
        );
      } finally {
        db.close();
      }
      observations.push({
        concurrency,
        simultaneousAdmissions: paths.length,
        distinctJobs: true,
        unrelatedTaskPreserved: true,
        cancelledSlotReused: true,
      });
    } finally {
      const stopping = runtime.stop();
      for (const barrier of starts.values()) barrier.resolve();
      await stopping;
    }
  }
  writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  return observations;
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Pass a disposable evidence directory");
  console.log(JSON.stringify(await probeParallelRuntime(root)));
}
