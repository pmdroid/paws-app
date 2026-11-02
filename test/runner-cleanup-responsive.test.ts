import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerCommand, RunnerTermination } from "../src/runner-protocol";
import { openRunnerRuntime } from "../src/runner-runtime";

for (const failure of ["hung", "rejected"] as const)
  test(`a ${failure} broker stop leaves commands and heartbeats responsive and confirms teardown once`, async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-cleanup-responsive-"));
    const now = Date.now();
    const paired = {
      phase: "paired" as const,
      runnerId: "runner",
      workspaceId: "workspace",
      fingerprint: "fixture",
      expiresAt: now + 3_600_000,
    };
    const work = (id: string, runId: string): RunnerCommand => ({
      id,
      type: "task",
      runId,
      itemId: `item-${runId}`,
      generation: 1,
      runnerId: "runner",
      workspaceId: "workspace",
      issuedAt: now,
      expiresAt: now + 600_000,
      sessionId: "session",
      sessionGeneration: 1,
      taskModeGeneration: 1,
      purpose: "answer",
      profile: { agent: "claude", model: null },
      prompt: "Implement the assigned issue",
    });
    const cancel = (id: string, runId: string): RunnerCommand => ({
      id,
      type: "cancel",
      runId,
      generation: 1,
      runnerId: "runner",
      workspaceId: "workspace",
      issuedAt: now,
      expiresAt: now + 60_000,
    });
    let commands: RunnerCommand[] = [work("first", "run-a")];
    let leased = ["run-a"];
    const calls: string[] = [];
    let release!: () => void;
    const termination = new Promise<void>((resolve) => {
      release = resolve;
    });
    let confirmed = false;
    let pendingStops = 0;
    let mostPendingStops = 0;
    let heartbeats = 0;
    const live: { runId: string; generation: number }[][] = [];
    const terminated: RunnerTermination[] = [];
    const spool = {
      root: join(root, "spool"),
      runnerUid: process.getuid!(),
      agentGid: process.getgid!(),
    };
    mkdirSync(spool.root);
    chmodSync(spool.root, 0o750);
    const options: Parameters<typeof openRunnerRuntime>[0] = {
      root,
      repositoryRoot: join(root, "repositories"),
      home: root,
      concurrency: 1,
      stopWaitMs: 2_000,
      cleanupAttemptMs: 40,
      cleanupRetryMs: 10,
      spool,
      results: { root: join(root, "results"), agentUid: 1002, resultsGid: 1003 },
      broker: {
        async start() {
          calls.push("start");
          return { alreadyAdmitted: false };
        },
        async stop() {
          calls.push("stop");
          if (confirmed) return;
          if (failure === "rejected") throw new Error("stop rejected");
          pendingStops++;
          mostPendingStops = Math.max(mostPendingStops, pendingStops);
          try {
            await termination;
          } finally {
            pendingStops--;
          }
        },
      },
      daemon: {
        status: () => paired,
        async heartbeat(_skills, _runtimes, _agents, reported, reports) {
          heartbeats++;
          live.push([...(reported ?? [])]);
          terminated.push(...(reports ?? []));
          return {
            leases: leased.map((runId) => ({ runId, generation: 1, expiresAt: now + 600_000 })),
            fenced: [],
            terminated: [...(reports ?? [])],
          };
        },
        async pollCommands() {
          return { commands, rejected: [], deniedRepositories: [] };
        },
        pendingCommands: () => commands,
        async acknowledgeCommand(id) {
          calls.push(`ack:${id}`);
          commands = commands.filter((command) => command.id !== id);
        },
        async issueRunGrant() {
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
          throw new Error("unused");
        },
        async renewCertificate() {
          return paired;
        },
        async uploadTranscript() {
          throw new Error("unused");
        },
        async finishTranscript() {
          throw new Error("unused");
        },
        async uploadArtifact() {
          return { ok: true };
        },
      },
    };
    let runtime = await openRunnerRuntime(options);
    try {
      await runtime.tick();
      for (let i = 0; i < 100 && !calls.includes("start"); i++) await Bun.sleep(5);
      expect(calls.filter((call) => call === "start")).toHaveLength(1);
      commands = [cancel("cancel-first", "run-a"), work("second", "run-b")];
      leased = ["run-b"];
      await runtime.tick();
      for (let i = 0; i < 100 && !runtime.status().cleanup.some((entry) => entry.degraded); i++)
        await Bun.sleep(5);

      commands = [...commands, cancel("cancel-other", "run-z")];
      const before = heartbeats;
      const started = performance.now();
      for (let i = 0; i < 3; i++) await runtime.tick();
      expect(performance.now() - started).toBeLessThan(1_500);
      expect(heartbeats - before).toBeGreaterThanOrEqual(3);
      expect(calls).toContain("ack:cancel-first");
      expect(calls).toContain("ack:cancel-other");
      expect(calls).not.toContain("ack:second");
      expect(live.at(-1)).toEqual([{ runId: "run-a", generation: 1 }]);
      expect(terminated).toEqual([{ runId: "run-z", generation: 1, commandId: "cancel-other" }]);
      const [stuck] = runtime.status().cleanup;
      expect(runtime.status().cleanup).toHaveLength(1);
      expect(stuck).toMatchObject({ runId: "run-a", generation: 1, commandId: "first" });
      expect(stuck!.degraded).toBe(true);
      expect(stuck!.failure).toContain(
        failure === "hung" ? "did not finish within 40 ms" : "stop rejected",
      );
      if (failure === "hung") expect(mostPendingStops).toBe(1);

      await runtime.stop();
      runtime = await openRunnerRuntime(options);
      const restored = runtime.status().cleanup;
      expect(restored).toHaveLength(1);
      expect(restored[0]).toMatchObject({ runId: "run-a", generation: 1, commandId: "first" });
      expect(restored[0]!.failures).toBeGreaterThanOrEqual(stuck!.failures);
      await runtime.tick();
      expect(calls).not.toContain("ack:second");
      expect(live.at(-1)).toContainEqual({ runId: "run-a", generation: 1 });

      confirmed = true;
      release();
      for (let i = 0; i < 100 && !calls.includes("ack:second"); i++) {
        await Bun.sleep(5);
        await runtime.tick();
      }
      expect(calls).toContain("ack:second");
      await runtime.tick();
      await runtime.tick();
      expect(runtime.status().cleanup).toEqual([]);
      expect(
        terminated.filter((entry) => entry.runId === "run-a" && entry.generation === 1),
      ).toEqual([{ runId: "run-a", generation: 1, commandId: "first" }]);
      expect(live.at(-1)).not.toContainEqual({ runId: "run-a", generation: 1 });
    } finally {
      confirmed = true;
      release();
      await runtime.stop();
      await Bun.sleep(0);
      rmSync(root, { recursive: true, force: true });
    }
  });
