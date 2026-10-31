import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function fixture(
  options: {
    budget?: boolean;
    aliveOffsetMs?: number;
    connectionError?: boolean;
    expiresMs?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-outage-"));
  const now = Date.now();
  let clock = 0;
  let wall = now;
  let stops = 0;
  let missing = false;
  let postFailures = 0;
  let postAttempts = 0;
  const events: unknown[] = [];
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
    expiresAt: now + (options.expiresMs ?? 3_600_000),
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
    if (down && options.connectionError) throw new Error("ECONNREFUSED");
    if (down) throw new RunnerRequestError(503, "POST", "/v1/heartbeat", 7);
  };
  const runtimeOptions: Parameters<typeof openRunnerRuntime>[0] = {
    root,
    spool,
    results,
    repositoryRoot: join(root, "repositories"),
    home: root,
    now: () => wall,
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
      async stop() {
        stops++;
      },
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
                aliveAt: wall + (options.aliveOffsetMs ?? 0),
              };
        return fenced
          ? { leases: [], fenced: [{ runId: "run", generation: 1 }], ...budget }
          : {
              leases: missing ? [] : [{ runId: "run", generation: 1, expiresAt: wall + 60_000 }],
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
      async sendEvent(event) {
        reachable();
        events.push(event);
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
        postAttempts++;
        if (postFailures-- > 0) throw new RunnerRequestError(503, "POST", "/result", 1);
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
  };
  let runtime = await openRunnerRuntime(runtimeOptions);
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
    rejectResults: (times: number) => {
      postFailures = times;
    },
    postAttempts: () => postAttempts,
    errors,
    events,
    stopped: () => stops,
    missing: () => (missing = true),
    jumpWall: (ms: number) => (wall += ms),
    event: (event: unknown) =>
      appendFileSync(join(results.root, execution, "events.jsonl"), JSON.stringify(event) + "\n"),
    restart: async () => {
      await runtime.stop();
      runtime = await openRunnerRuntime(runtimeOptions);
    },
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

test("connection errors for twenty minutes retain events and deliver a result once", async () => {
  const f = await fixture({ connectionError: true });
  try {
    f.goDown();
    await f.tick();
    f.event({ type: "progress", text: "Working offline" });
    f.advance(20 * 60_000);
    await f.tick();
    await Bun.sleep(300);
    expect(f.stopped()).toBe(0);
    f.finish();
    f.comeBack();
    await f.tickUntil(() => f.posted.length > 0);
    await f.tick();
    expect(f.events).toContainEqual(
      expect.objectContaining({ event: { type: "progress", text: "Working offline" } }),
    );
    expect(f.posted.map((result) => result.stopReason)).toEqual(["end_turn"]);
  } finally {
    await f.cleanup();
  }
});

test("a heartbeat answering without this lease stops the worker immediately", async () => {
  const f = await fixture();
  try {
    f.missing();
    await f.tick();
    expect(f.stopped()).toBe(1);
    expect(f.errors.join("\n")).toContain("heartbeat did not renew the lease");
    expect(f.posted).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("an offline watchdog failure survives restart and is posted after reconnect", async () => {
  const f = await fixture();
  try {
    f.goDown();
    await f.tick();
    f.advance(RUNNER_OFFLINE_BUDGET_MS + 6 * 60_000);
    await Bun.sleep(300);
    expect(f.stopped()).toBe(1);
    expect(f.posted).toEqual([]);
    await f.restart();
    f.comeBack();
    await f.tickUntil(() => f.posted.length > 0);
    await f.tick();
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0]!.errorMessage).toContain("lease deadline passed");
  } finally {
    await f.cleanup();
  }
});

test("sleep and wall-clock jumps spend no active command time", async () => {
  const f = await fixture({ expiresMs: 25 * 60_000 });
  try {
    f.goDown();
    await f.tick();
    f.jumpWall(24 * 60 * 60_000);
    await Bun.sleep(300);
    expect(f.stopped()).toBe(0);
    f.advance(24 * 60_000);
    await Bun.sleep(300);
    expect(f.stopped()).toBe(0);
    f.advance(60_000);
    await Bun.sleep(300);
    expect(f.stopped()).toBe(1);
  } finally {
    await f.cleanup();
  }
});

test("waiting for a question or finished result does not spend offline budget", async () => {
  for (const wait of ["question", "result"]) {
    const f = await fixture();
    try {
      f.goDown();
      await f.tick();
      if (wait === "question")
        f.event({
          type: "question",
          requestId: crypto.randomUUID(),
          question: "Continue?",
          options: [],
        });
      else f.finish();
      await Bun.sleep(300);
      f.advance(2 * RUNNER_OFFLINE_BUDGET_MS);
      await Bun.sleep(300);
      expect(f.stopped()).toBe(0);
      f.comeBack();
      if (wait === "result") {
        await f.tickUntil(() => f.posted.length > 0);
        expect(f.posted[0]!.stopReason).toBe("end_turn");
      }
    } finally {
      await f.cleanup();
    }
  }
});

test("a prepared success survives an unavailable result endpoint and a runner restart", async () => {
  const f = await fixture();
  try {
    f.rejectResults(1);
    f.finish();
    await f.tickUntil(() => f.postAttempts() > 0);
    expect(f.posted).toEqual([]);
    await f.restart();
    await f.tickUntil(() => f.posted.length > 0);
    await f.tick();
    expect(f.posted.map((result) => result.stopReason)).toEqual(["end_turn"]);
    expect(f.postAttempts()).toBe(2);
  } finally {
    await f.cleanup();
  }
});
