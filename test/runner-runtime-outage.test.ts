import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunnerRequestError } from "../src/runner-daemon";
import { openRunnerRuntime } from "../src/runner-runtime";
import {
  PAWS_ALIVE_LEASE_SKEW_MS,
  RUNNER_OFFLINE_BUDGET_MS,
  type RunnerCommand,
  type RunnerResult,
} from "../src/runner-protocol";

async function fixture(options: { budget?: boolean; aliveOffsetMs?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-outage-"));
  const now = Date.now();
  let clock = 0;
  let down = false;
  let fenced = false;
  let finished = false;
  let refusal = { status: 0, times: 0, sent: 0 };
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
  const command: RunnerCommand = {
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
    purpose: "answer",
    issuedAt: now,
    expiresAt: now + 3_600_000,
    profile: { agent: "claude", model: null },
    prompt: "signed prompt",
  };
  const paired = {
    phase: "paired" as const,
    runnerId: "runner",
    workspaceId: "workspace",
    fingerprint: "fixture",
    expiresAt: now + 3_600_000,
  };
  let pending: RunnerCommand[] = [command];
  let execution = "";
  const posted: RunnerResult[] = [];
  const errors: string[] = [];
  const reachable = () => {
    if (down) throw new RunnerRequestError(503, "POST", "/v1/heartbeat", 7);
  };
  const runtime = await openRunnerRuntime({
    root,
    spool,
    results,
    repositoryRoot: join(root, "repositories"),
    home: root,
    now: () => now,
    monotonic: () => clock,
    onError: (error) => errors.push(error.message),
    broker: {
      async start(id) {
        execution = id;
        const directory = join(results.root, id);
        mkdirSync(directory);
        chmodSync(directory, 0o750);
        writeFileSync(join(directory, "events.jsonl"), "");
        chmodSync(join(directory, "events.jsonl"), 0o640);
        return { alreadyAdmitted: false };
      },
      async stop() {},
      alive: () => !finished,
    },
    daemon: {
      status: () => paired,
      async heartbeat() {
        reachable();
        const budget =
          options.budget === false
            ? {}
            : {
                offlineBudgetMs: RUNNER_OFFLINE_BUDGET_MS,
                aliveAt: now + (options.aliveOffsetMs ?? 0),
              };
        return fenced
          ? { leases: [], fenced: [{ runId: "run", generation: 1 }], ...budget }
          : {
              leases: [{ runId: "run", generation: 1, expiresAt: now + 60_000 }],
              fenced: [],
              ...budget,
            };
      },
      async pollCommands() {
        reachable();
        return { commands: pending, rejected: [], deniedRepositories: [] };
      },
      pendingCommands: () => pending,
      async acknowledgeCommand(id) {
        pending = pending.filter((entry) => entry.id !== id);
      },
      async issueRunGrant() {
        reachable();
        return { token: "token", expiresAt: now + 60_000 };
      },
      async sendEvent() {
        reachable();
        return { duplicate: false };
      },
      async answers() {
        reachable();
        if (refusal.times > refusal.sent) {
          refusal.sent += 1;
          throw new RunnerRequestError(refusal.status, "POST", "/v1/runs/run/answers", 9_000);
        }
        return { answers: [] };
      },
      async postResult(_runId, _generation, result) {
        reachable();
        posted.push(result);
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
        reachable();
        return { offset: chunk.offset, duplicate: false };
      },
      async finishTranscript() {
        reachable();
        return { uri: "transcript" };
      },
    },
  });
  const tick = () => runtime.tick().catch((error: Error) => errors.push(error.message));
  const tickUntil = async (done: () => boolean) => {
    for (let index = 0; index < 400 && !done(); index++) {
      await tick();
      await Bun.sleep(1);
    }
  };
  await tickUntil(() => execution !== "");
  return {
    posted,
    errors,
    tick,
    tickUntil,
    goDown: () => (down = true),
    comeBack: () => (down = false),
    fence: () => (fenced = true),
    /** Paws answers the run's next `times` answer polls with `status`. */
    refuse: (status: number, times: number) => (refusal = { status, times, sent: 0 }),
    refused: () => refusal.sent,
    advance: (ms: number) => (clock += ms),
    finish() {
      writeFileSync(
        join(results.root, execution, "result.json"),
        JSON.stringify({
          executionId: execution,
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
      );
      chmodSync(join(results.root, execution, "result.json"), 0o640);
      finished = true;
    },
    async cleanup() {
      await runtime.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a run keeps going while Paws is unreachable for longer than its lease and delivers its result",
  async () => {
    const f = await fixture();
    try {
      f.goDown();
      f.advance(90_000);
      await f.tick();
      await Bun.sleep(300);
      f.finish();
      await f.tick();
      await Bun.sleep(300);
      expect(f.posted).toEqual([]);
      f.comeBack();
      await f.tickUntil(() => f.posted.length > 0);
      expect(f.posted.map((result) => result.stopReason)).toEqual(["end_turn"]);
      expect(f.errors.join("\n")).not.toContain("lease deadline passed");
      expect(f.errors.join("\n")).toContain(
        "Runner request POST /v1/heartbeat failed with HTTP 503 after 7 ms.",
      );
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a run that Paws fenced during the outage stops when the runner reconnects",
  async () => {
    const f = await fixture();
    try {
      f.goDown();
      f.advance(90_000);
      await f.tick();
      await Bun.sleep(300);
      f.fence();
      f.comeBack();
      await f.tickUntil(() => f.errors.some((error) => error.includes("fenced by Paws")));
      f.finish();
      await f.tick();
      await Bun.sleep(100);
      expect(f.errors.join("\n")).toContain("fenced by Paws");
      expect(f.posted.map((result) => result.stopReason)).not.toContain("end_turn");
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a run whose request Paws answers 503 retries it and continues",
  async () => {
    const f = await fixture();
    try {
      f.refuse(503, 3);
      await f.tickUntil(() => f.refused() === 3);
      f.finish();
      await f.tickUntil(() => f.posted.length > 0);
      expect(f.posted.map((result) => result.stopReason)).toEqual(["end_turn"]);
      expect(f.errors.join("\n")).toContain(
        "Runner request POST /v1/runs/run/answers failed with HTTP 503 after 9000 ms.",
      );
      expect(f.errors.join("\n")).not.toContain("Runner interrupted");
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a run whose request Paws refuses with 403 stops",
  async () => {
    const f = await fixture();
    try {
      f.refuse(403, 1);
      await f.tickUntil(() => f.posted.length > 0);
      expect(f.posted.map((result) => result.stopReason)).toEqual(["error"]);
      expect(f.errors.join("\n")).toContain("Runner interrupted");
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a runner told the offline budget keeps the same deadline Paws credits for 20 minutes",
  async () => {
    const f = await fixture();
    try {
      f.goDown();
      await f.tick();
      f.advance(20 * 60_000);
      await f.tick();
      await Bun.sleep(300);
      expect(f.errors.join("\n")).not.toContain("lease deadline passed");
      f.finish();
      f.comeBack();
      await f.tickUntil(() => f.posted.length > 0);
      expect(f.posted.map((result) => result.stopReason)).toEqual(["end_turn"]);
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a runner without the offline budget still stops at its lease plus the grace",
  async () => {
    const f = await fixture({ budget: false });
    try {
      f.goDown();
      await f.tick();
      f.advance(20 * 60_000);
      await f.tick();
      const stopped = () => f.errors.some((error) => error.includes("lease deadline passed"));
      for (let index = 0; index < 40 && !stopped(); index++) await Bun.sleep(25);
      expect(f.errors.join("\n")).toContain("lease deadline passed");
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a runner whose lease sits past the alive skew still stops at the grace",
  async () => {
    const f = await fixture({ aliveOffsetMs: -(PAWS_ALIVE_LEASE_SKEW_MS - 60_000) - 1 });
    try {
      f.goDown();
      await f.tick();
      f.advance(20 * 60_000);
      await f.tick();
      const stopped = () => f.errors.some((error) => error.includes("lease deadline passed"));
      for (let index = 0; index < 40 && !stopped(); index++) await Bun.sleep(25);
      expect(f.errors.join("\n")).toContain("lease deadline passed");
    } finally {
      await f.cleanup();
    }
  },
);

test.skipIf(process.platform !== "linux" || process.getuid!() === 0 || process.getgid!() === 0)(
  "a runner told the offline budget stops once downtime passes that budget",
  async () => {
    const f = await fixture();
    try {
      f.goDown();
      await f.tick();
      f.advance(RUNNER_OFFLINE_BUDGET_MS + 60_000 + 5 * 60_000);
      await f.tick();
      const stopped = () => f.errors.some((error) => error.includes("lease deadline passed"));
      for (let index = 0; index < 40 && !stopped(); index++) await Bun.sleep(25);
      expect(f.errors.join("\n")).toContain("lease deadline passed");
    } finally {
      await f.cleanup();
    }
  },
);
