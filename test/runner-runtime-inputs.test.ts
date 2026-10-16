import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRunnerRuntime } from "../src/runner-runtime";
import { readRunnerJobInputs } from "../src/runner-execution";
import type { RunnerCommand } from "../src/runner-protocol";

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
async function fixture(purpose: "answer" | "artifact", context: boolean) {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-inputs-"));
  let now = Date.now();
  const spool = {
    root: join(root, "spool"),
    runnerUid: process.getuid!(),
    agentGid: process.getgid!(),
  };
  mkdirSync(spool.root);
  chmodSync(spool.root, 0o2750);
  const bytes = Buffer.from([0, 255, 20, 40]);
  const prompt = Buffer.from("restored Unicode context 🐕".repeat(4000));
  const command: Extract<RunnerCommand, { type: "task" }> = {
    id: "command",
    type: "task",
    runnerId: "runner",
    workspaceId: "workspace",
    runId: "run",
    itemId: "item",
    generation: 1,
    sessionId: "session",
    sessionGeneration: 1,
    taskModeGeneration: 1,
    purpose,
    issuedAt: now,
    expiresAt: now + 60_000,
    profile: { agent: "claude", model: null },
    prompt: "signed prompt",
    inputFiles: [
      {
        id: 0,
        path: ".paws-linear-inputs/private.bin",
        mimeType: "application/octet-stream",
        sizeBytes: bytes.length,
        sha256: hash(bytes),
      },
    ],
    ...(context ? { promptContext: { sizeBytes: prompt.length, sha256: hash(prompt) } } : {}),
  };
  const paired = {
    phase: "paired" as const,
    runnerId: "runner",
    workspaceId: "workspace",
    fingerprint: "fixture",
    expiresAt: now + 3_600_000,
  };
  const commands: RunnerCommand[] = [command];
  let grants = 0;
  const starts: string[] = [];
  const stops: string[] = [];
  const daemon: Parameters<typeof openRunnerRuntime>[0]["daemon"] = {
    status: () => paired,
    async heartbeat() {
      return { leases: [{ runId: "run", generation: 1, expiresAt: now + 60_000 }], fenced: [] };
    },
    async pollCommands() {
      return { commands, rejected: [], deniedRepositories: [] };
    },
    pendingCommands: () => commands,
    async acknowledgeCommand() {},
    async issueRunGrant() {
      grants++;
      return { token: String(grants), expiresAt: now + 6000 };
    },
    async sendEvent() {
      throw new Error("No worker result");
    },
    async answers() {
      return { answers: [] };
    },
    async postResult() {
      throw new Error("No worker result");
    },
    async repositoryCredential() {
      throw new Error("Repository-free task");
    },
    async renewCertificate() {
      return paired;
    },
    async uploadArtifact() {
      throw new Error("No worker result");
    },
    async uploadTranscript() {
      throw new Error("No worker result");
    },
    async finishTranscript() {
      throw new Error("No worker result");
    },
  };
  const open = () =>
    openRunnerRuntime({
      root,
      daemon,
      spool,
      results: {
        root: join(root, "results"),
        agentUid: process.getuid!(),
        resultsGid: process.getgid!(),
      },
      repositoryRoot: join(root, "repositories"),
      home: root,
      now: () => now,
      broker: {
        async start(id) {
          starts.push(id);
          return { alreadyAdmitted: false };
        },
        async stop(id) {
          stops.push(id);
        },
      },
    });
  return {
    root,
    spool,
    bytes,
    prompt,
    command,
    commands,
    daemon,
    open,
    starts,
    stops,
    advance: (ms: number) => {
      now += ms;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

for (const purpose of ["answer", "artifact"] as const)
  for (const context of [false, true])
    test(`runtime downloads ${purpose} signed inputs${context ? " and context" : ""} before publication`, async () => {
      const f = await fixture(purpose, context);
      let runtime: Awaited<ReturnType<typeof openRunnerRuntime>> | undefined;
      try {
        const tokens: string[] = [];
        f.daemon.readInputs = async (command, grant, signal) => {
          expect(command).toEqual(f.command);
          expect(signal.aborted).toBe(false);
          expect(readdirSync(f.spool.root)).toEqual([]);
          tokens.push(await grant());
          f.advance(2000);
          tokens.push(await grant());
          return { inputFiles: [f.bytes], ...(context ? { promptContext: f.prompt } : {}) };
        };
        runtime = await f.open();
        await runtime.tick();
        for (let i = 0; i < 100 && !f.starts.length; i++) await Bun.sleep(1);
        expect(f.starts.length).toBe(1);
        expect(tokens).toEqual(["1", "2"]);
        const stored = readRunnerJobInputs(f.spool, f.starts[0]!);
        expect(Buffer.from(stored.inputFiles[0]!.bytes)).toEqual(f.bytes);
        expect(stored.prompt).toBe(context ? f.prompt.toString() : f.command.prompt);
      } finally {
        await runtime?.stop();
        f.cleanup();
      }
    });

for (const failure of ["missing-port", "corrupt", "expired", "stop", "cancel"] as const)
  test(`runtime refuses input publication after ${failure}`, async () => {
    const f = await fixture("answer", true);
    let entered!: () => void;
    const downloading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let runtime: Awaited<ReturnType<typeof openRunnerRuntime>> | undefined;
    try {
      if (failure !== "missing-port")
        f.daemon.readInputs = async (_command, grant, signal) => {
          await grant();
          entered();
          if (failure === "stop" || failure === "cancel") await blocked;
          if (failure === "expired") f.advance(60_001);
          expect(signal.aborted).toBe(failure === "stop" || failure === "cancel");
          return {
            inputFiles: [failure === "corrupt" ? Buffer.from("wrong") : f.bytes],
            promptContext: f.prompt,
          };
        };
      runtime = await f.open();
      await runtime.tick();
      if (failure === "stop" || failure === "cancel") {
        await downloading;
        if (failure === "stop") {
          const stopping = runtime.stop();
          release();
          await stopping;
        } else {
          f.commands.unshift({
            id: "cancel",
            type: "cancel",
            runId: "run",
            generation: 1,
            runnerId: "runner",
            workspaceId: "workspace",
            issuedAt: f.command.issuedAt,
            expiresAt: f.command.expiresAt,
          });
          const ticking = runtime.tick();
          await Bun.sleep(1);
          release();
          await ticking;
        }
      }
      for (let i = 0; i < 100 && !f.stops.length; i++) await Bun.sleep(1);
      expect(f.starts).toEqual([]);
      expect(f.stops.length).toBe(1);
      expect(readdirSync(f.spool.root)).toEqual([]);
    } finally {
      release();
      await runtime?.stop();
      f.cleanup();
    }
  });
