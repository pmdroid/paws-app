import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db";
import { openRunnerHealthRuntime } from "../src/runner-health-runtime";
import { RunnerCommandSchema, type RunnerCommand } from "../src/runner-protocol";

test.skipIf(process.getuid!() === 0)(
  "interactive login stays alive beyond a health probe and stops at its signed expiry",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-login-runtime-"));
    mkdirSync(join(root, "spool"), { mode: 0o750 });
    chmodSync(join(root, "spool"), 0o750);
    const start = Date.now();
    let elapsed = 0;
    const command: RunnerCommand = {
      id: randomUUID(),
      type: "login",
      workspaceId: "workspace",
      runnerId: "runner",
      agent: "codex",
      issuedAt: start,
      expiresAt: start + 600_000,
    };
    const calls: string[] = [];
    const runtime = await openRunnerHealthRuntime({
      root,
      now: () => start + elapsed,
      monotonic: () => elapsed,
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
      daemon: {
        status: () => ({
          phase: "paired",
          runnerId: "runner",
          workspaceId: "workspace",
          fingerprint: "fixture",
          expiresAt: start + 3_600_000,
        }),
        pendingCommands: () => [command],
        async pollCommands() {
          return { commands: [], rejected: [], deniedRepositories: [] };
        },
        async acknowledgeCommand() {
          calls.push("ack");
        },
        async postHealth() {
          throw new Error("Interactive login cannot publish a health probe");
        },
        async heartbeat() {
          throw new Error("Interactive login cannot use a run lease");
        },
        async exchangeLogin() {
          calls.push("exchange");
          return { cancelled: false, input: null };
        },
      },
      broker: {
        async start() {
          calls.push("start");
          return { alreadyAdmitted: false };
        },
        async stop() {
          calls.push("stop");
        },
      },
    });
    try {
      await runtime.tick();
      expect(calls).toEqual(["exchange", "start", "ack"]);
      elapsed = 61_000;
      await runtime.tick();
      expect(calls).toEqual(["exchange", "start", "ack", "exchange"]);
      elapsed = 600_001;
      await runtime.tick();
      expect(calls.at(-1)).toBe("stop");
      expect(calls.filter((call) => call === "start")).toHaveLength(1);
    } finally {
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.getuid!() === 0).each(["connected", "running"] as const)(
  "login %s receipts survive offline delivery and restart without repeating authentication",
  async (state) => {
    const root = mkdtempSync(join(tmpdir(), "paws-login-recovery-"));
    const at = Date.now();
    const id = "01J00000000000000000000001";
    const command: RunnerCommand = {
      id: randomUUID(),
      type: "login",
      workspaceId: "workspace",
      runnerId: "runner",
      agent: "claude",
      issuedAt: at,
      expiresAt: at + 600_000,
    };
    const finished = { state: "connected", terminal: "", authorization: null, inputId: null };
    const seed = openDatabase(join(root, "health.db"));
    seed.run(
      "CREATE TABLE health_execution(id TEXT PRIMARY KEY,command_id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,phase TEXT NOT NULL,result TEXT) STRICT",
    );
    seed.run("INSERT INTO health_execution VALUES(?,?,?,?,?)", [
      id,
      command.id,
      JSON.stringify(RunnerCommandSchema.parse(command)),
      state === "connected" ? "publishing" : "running",
      state === "connected" ? JSON.stringify(finished) : null,
    ]);
    seed.close();
    let offline = true;
    const calls: string[] = [];
    const updates: string[] = [];
    const options: Parameters<typeof openRunnerHealthRuntime>[0] = {
      root,
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
      daemon: {
        status: () => ({
          phase: "paired",
          runnerId: "runner",
          workspaceId: "workspace",
          fingerprint: "fixture",
          expiresAt: at + 3_600_000,
        }),
        pendingCommands: () => [command],
        async pollCommands() {
          return { commands: [], rejected: [], deniedRepositories: [] };
        },
        async acknowledgeCommand() {
          calls.push("ack");
        },
        async postHealth() {
          throw new Error("Login cannot publish health");
        },
        async heartbeat() {
          return { leases: [], fenced: [] };
        },
        async exchangeLogin(commandId, update) {
          expect(commandId).toBe(command.id);
          updates.push(update.state);
          expect(update).toEqual({
            ...finished,
            state: state === "connected" ? "connected" : "failed",
          });
          if (offline) throw new Error("Offline");
          return { cancelled: false, input: null };
        },
      },
      broker: {
        async start() {
          calls.push("start");
          throw new Error("Authentication must not repeat");
        },
        async stop(executionId) {
          expect(executionId).toBe(id);
          calls.push("stop");
        },
      },
    };
    let runtime: Awaited<ReturnType<typeof openRunnerHealthRuntime>> | undefined;
    try {
      runtime = await openRunnerHealthRuntime(options);
      await runtime.tick();
      await runtime.stop();
      offline = false;
      runtime = await openRunnerHealthRuntime(options);
      await runtime.tick();
      expect(runtime.status().active).toBeNull();
      await runtime.tick();
      expect(calls).not.toContain("start");
      expect(calls).toContain("ack");
      expect(updates).toEqual(
        state === "connected" ? ["connected", "connected"] : ["failed", "failed"],
      );
      const saved = openDatabase(join(root, "health.db"));
      try {
        expect(
          saved.query<{ phase: string }, []>("SELECT phase FROM health_execution").get()?.phase,
        ).toBe("complete");
      } finally {
        saved.close();
      }
    } finally {
      await runtime?.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
