import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/db";
import { openRunnerRuntime } from "../src/runner-runtime";
import type { RunnerCommand } from "../src/runner-protocol";

test("shutdown during a cancellation acknowledgment cannot admit another pending run", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-stop-"));
  const now = Date.now();
  const paired = {
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
      type: "run",
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
      profile: { agent: "claude", model: null },
      prompt: "Implement the assigned issue",
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
  const runtime = await openRunnerRuntime({
    root,
    repositoryRoot: join(root, "repositories"),
    home: root,
    spool: { root: join(root, "spool"), runnerUid: 1001, agentGid: 1002 },
    results: { root: join(root, "results"), agentUid: 1002, resultsGid: 1003 },
    broker: {
      async start() {
        calls.push("start");
        return { alreadyAdmitted: false };
      },
      async stop() {
        calls.push("stop");
        await brokerStop;
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
        return { commands, rejected: [], deniedRepositories: [] };
      },
      pendingCommands: () => commands,
      async acknowledgeCommand(id) {
        calls.push(`ack:${id}`);
        if (id === "cancel") {
          acknowledgeEntered();
          await acknowledgment;
        }
      },
      async issueRunGrant() {
        calls.push("grant");
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
        throw new Error("Repository access must not begin after shutdown");
      },
      async renewCertificate() {
        return paired;
      },
      async uploadTranscript() {
        throw new Error("Transcript upload must not begin after shutdown");
      },
      async finishTranscript() {
        throw new Error("Transcript sealing must not begin after shutdown");
      },
      async uploadArtifact() {
        return { ok: true };
      },
    },
  });
  try {
    const ticking = runtime.tick();
    await entered;
    const stopping = runtime.stop();
    releaseAcknowledgment();
    await Promise.all([ticking, stopping]);
    const db = openDatabase(join(root, "executions.db"));
    try {
      expect(
        db.query<{ count: number }, []>("SELECT count(*) AS count FROM execution").get()!.count,
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

for (const failure of ["hung", "rejected"] as const)
  test(`a ${failure} stop holds capacity and heartbeat ownership across restart until termination`, async () => {
    const root = mkdtempSync(join(tmpdir(), "paws-runtime-stuck-"));
    const now = Date.now();
    const paired = {
      phase: "paired" as const,
      runnerId: "runner",
      workspaceId: "workspace",
      fingerprint: "fixture",
      expiresAt: now + 3_600_000,
    };
    const run = (id: string, runId: string): RunnerCommand => ({
      id,
      type: "task",
      runId,
      itemId: `item-${runId}`,
      generation: 1,
      runnerId: "runner",
      workspaceId: "workspace",
      issuedAt: now,
      expiresAt: now + 60_000,
      sessionId: "session",
      sessionGeneration: 1,
      taskModeGeneration: 1,
      purpose: "answer",
      profile: { agent: "claude", model: null },
      prompt: "Implement the assigned issue",
    });
    let commands: RunnerCommand[] = [run("first", "run-a")];
    let leased = ["run-a"];
    const calls: string[] = [];
    const spool = {
      root: join(root, "spool"),
      runnerUid: process.getuid!(),
      agentGid: process.getgid!(),
    };
    mkdirSync(spool.root);
    chmodSync(spool.root, 0o750);
    let release!: () => void;
    const termination = new Promise<void>((resolve) => {
      release = resolve;
    });
    let confirmed = false;
    const reports: { runId: string; generation: number }[][] = [];
    const terminations: { runId: string; generation: number; commandId: string }[][] = [];
    const options: Parameters<typeof openRunnerRuntime>[0] = {
      root,
      repositoryRoot: join(root, "repositories"),
      home: root,
      concurrency: 1,
      stopWaitMs: 50,
      spool,
      results: { root: join(root, "results"), agentUid: 1002, resultsGid: 1003 },
      broker: {
        async start() {
          calls.push("start");
          return { alreadyAdmitted: false };
        },
        async stop() {
          if (confirmed) return;
          if (failure === "rejected") throw new Error("stop rejected");
          await termination;
        },
      },
      daemon: {
        status: () => paired,
        async heartbeat(_skills, _runtimes, _agents, live, terminated) {
          reports.push([...(live ?? [])]);
          terminations.push([...(terminated ?? [])]);
          return {
            leases: leased.map((runId) => ({ runId, generation: 1, expiresAt: now + 60_000 })),
            fenced: [],
          };
        },
        async pollCommands() {
          return { commands, rejected: [], deniedRepositories: [] };
        },
        pendingCommands: () => commands,
        async acknowledgeCommand(id) {
          calls.push(`ack:${id}`);
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
      expect(calls).toContain("ack:first");
      expect(calls.filter((call) => call === "start")).toHaveLength(1);
      commands = [
        {
          id: "cancel-first",
          type: "cancel",
          runId: "run-a",
          generation: 1,
          runnerId: "runner",
          workspaceId: "workspace",
          issuedAt: now,
          expiresAt: now + 60_000,
        },
        run("second", "run-b"),
      ];
      leased = ["run-b"];
      await runtime.tick();
      await runtime.tick();
      expect(calls).toContain("ack:cancel-first");
      expect(calls).not.toContain("ack:second");
      expect(reports.at(-1)).toContainEqual({ runId: "run-a", generation: 1 });
      expect(terminations.at(-1)).toEqual([]);
      expect(runtime.status().active?.phase).toBe("cleaning");
      await runtime.stop();
      runtime = await openRunnerRuntime(options);
      await runtime.tick();
      expect(calls).toContain("ack:cancel-first");
      expect(calls).not.toContain("ack:second");
      expect(reports.at(-1)).toContainEqual({ runId: "run-a", generation: 1 });
      confirmed = true;
      release();
      for (let i = 0; i < 30 && !calls.includes("ack:second"); i++) {
        await Bun.sleep(5);
        await runtime.tick();
      }
      expect(calls).toContain("ack:second");
      for (let i = 0; i < 100 && calls.filter((call) => call === "start").length < 2; i++)
        await Bun.sleep(5);
      expect(calls.filter((call) => call === "start")).toHaveLength(2);
      await runtime.tick();
      expect(terminations.at(-1)).toContainEqual({
        runId: "run-a",
        generation: 1,
        commandId: "first",
      });
    } finally {
      confirmed = true;
      release();
      await runtime.stop();
      await Bun.sleep(0);
      rmSync(root, { recursive: true, force: true });
    }
  });

test("a command for a repository the runner does not allow is reported once", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-denied-"));
  const now = Date.now();
  const paired = {
    phase: "paired" as const,
    runnerId: "runner",
    workspaceId: "workspace",
    fingerprint: "fixture",
    expiresAt: now + 3_600_000,
  };
  const errors: string[] = [];
  const runtime = await openRunnerRuntime({
    root,
    repositoryRoot: join(root, "repositories"),
    home: root,
    spool: { root: join(root, "spool"), runnerUid: 1001, agentGid: 1002 },
    results: { root: join(root, "results"), agentUid: 1002, resultsGid: 1003 },
    onError: (error) => errors.push(error.message),
    broker: {
      async start() {
        return { alreadyAdmitted: false };
      },
      async stop() {},
    },
    daemon: {
      status: () => paired,
      async heartbeat() {
        return { leases: [], fenced: [] };
      },
      async pollCommands() {
        return {
          commands: [],
          rejected: ["repository_denied" as const],
          deniedRepositories: ["fixture/denied"],
        };
      },
      pendingCommands: () => [],
      async acknowledgeCommand() {},
      async issueRunGrant() {
        throw new Error("unused");
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
  });
  try {
    await runtime.tick();
    await runtime.tick();
    expect(errors).toEqual([
      "Runner refused a run for fixture/denied. Add it to allowedRepositories in the runner config.",
    ]);
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("lowering concurrency holds back new work and lets running work continue", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-concurrency-"));
  const now = Date.now();
  const paired = {
    phase: "paired" as const,
    runnerId: "runner",
    workspaceId: "workspace",
    fingerprint: "fixture",
    expiresAt: now + 3_600_000,
  };
  const run = (id: string, runId: string): RunnerCommand => ({
    id,
    type: "run",
    runId,
    itemId: `item-${runId}`,
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
    profile: { agent: "claude", model: null },
    prompt: "Implement the assigned issue",
  });
  let limit = 2;
  let commands: RunnerCommand[] = [run("first", "run-a"), run("second", "run-b")];
  const calls: string[] = [];
  const runtime = await openRunnerRuntime({
    root,
    repositoryRoot: join(root, "repositories"),
    home: root,
    concurrency: () => limit,
    stopWaitMs: 50,
    spool: { root: join(root, "spool"), runnerUid: 1001, agentGid: 1002 },
    results: { root: join(root, "results"), agentUid: 1002, resultsGid: 1003 },
    broker: {
      async start() {
        return { alreadyAdmitted: false };
      },
      async stop(id) {
        calls.push(`stop:${id}`);
      },
    },
    daemon: {
      status: () => paired,
      async heartbeat() {
        return {
          leases: commands.map((command) => ({
            runId: (command as { runId: string }).runId,
            generation: 1,
            expiresAt: now + 60_000,
          })),
          fenced: [],
        };
      },
      async pollCommands() {
        return { commands, rejected: [], deniedRepositories: [] };
      },
      pendingCommands: () => commands,
      async acknowledgeCommand(id) {
        calls.push(`ack:${id}`);
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
  });
  try {
    await runtime.tick();
    expect(calls).toEqual(["ack:first", "ack:second"]);
    limit = 1;
    commands = [...commands, run("third", "run-c")];
    await runtime.tick();
    await runtime.tick();
    expect(calls).toEqual(["ack:first", "ack:second"]);
    limit = 3;
    await runtime.tick();
    expect(calls).toEqual(["ack:first", "ack:second", "ack:third"]);
  } finally {
    await runtime.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
