import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunnerRequestError } from "../src/runner-daemon";
import { openRunnerRuntime } from "../src/runner-runtime";
import {
  PAWS_ALIVE_LEASE_SKEW_MS,
  RUNNER_OFFLINE_BUDGET_MS,
  RunnerResultSchema,
  type RunnerCommand,
  type RunnerResult,
} from "../src/runner-protocol";

async function fixture(
  options: {
    budget?: boolean;
    aliveOffsetMs?: number;
    connectionError?: boolean;
    expiresMs?: number;
    retryMs?: number;
    stopWaitMs?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "paws-runtime-outage-"));
  const now = Date.now();
  let clock = 0;
  let wall = now;
  let stops = 0;
  let stopFailure = false;
  let missing = false;
  let postFailures = 0;
  let postAttempts = 0;
  let permanentStatus = 0;
  let permanentReason: string | undefined;
  let grantAttempts = 0;
  let serverEnded = false;
  let seals = 0;
  let rejectSealed = false;
  let releasePost: (() => void) | undefined;
  let postGate: Promise<void> | undefined;
  const reports: string[][] = [];
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
    stopWaitMs: options.stopWaitMs,
    resultRetryMs: options.retryMs ?? 0,
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
        if (stopFailure) throw new Error("Worker cleanup unavailable");
        stops++;
      },
      alive: () => !finished,
    },
    daemon: {
      status: () => paired,
      async heartbeat(_skills, _runtimes, _agents, live) {
        reachable();
        reports.push((live ?? []).map((value) => value.runId));
        if (!pending.length && !posted.length && !live?.some((value) => value.runId === "run"))
          serverEnded = true;
        const budget =
          options.budget === false
            ? {}
            : {
                offlineBudgetMs: RUNNER_OFFLINE_BUDGET_MS,
                aliveAt: wall + (options.aliveOffsetMs ?? 0),
              };
        return fenced || serverEnded
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
        grantAttempts++;
        if (serverEnded) throw new RunnerRequestError(409, "POST", "/grant", 1);
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
        if (postGate) await postGate;
        if (serverEnded || permanentStatus)
          throw new RunnerRequestError(
            permanentStatus || 409,
            "POST",
            "/result",
            1,
            permanentReason,
          );
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
        if (seals && rejectSealed) throw new RunnerRequestError(409, "POST", "/finish", 1);
        seals++;
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
    root,
    posted,
    daemon: runtimeOptions.daemon,
    wall: () => wall,
    status: () => runtime.status(),
    stop: () => runtime.stop(),
    reports,
    seals: () => seals,
    grantAttempts: () => grantAttempts,
    rejectPermanently: (status: number, reason?: string) => {
      permanentStatus = status;
      permanentReason = reason;
    },
    rejectSealed: () => (rejectSealed = true),
    holdPost: () => {
      postGate = new Promise<void>((resolve) => {
        releasePost = resolve;
      });
    },
    releasePost: () => {
      releasePost?.();
      postGate = undefined;
    },
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
    crash: async (cleanupFails = false) => {
      await runtime.stop();
      const journal = new Database(join(root, "executions.db"));
      journal.run("UPDATE execution SET phase='running' WHERE phase='interrupted'");
      journal.close();
      stopFailure = cleanupFails;
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
    finish(run: Partial<RunnerResult> = {}) {
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
            ...run,
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
  "an idle runner without offline credit still stops at its lease plus the grace",
  async () => {
    const f = await fixture({ budget: false });
    try {
      f.finish();
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
      f.advance(RUNNER_OFFLINE_BUDGET_MS - 1);
      await Bun.sleep(300);
      expect(f.stopped()).toBe(0);
      f.advance(1);
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
      await f.tick();
      await Bun.sleep(300);
      f.advance(20 * 60_000);
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
    expect(f.errors.join("\n")).not.toContain("runner restarted");
  } finally {
    await f.cleanup();
  }
});

for (const stop of ["crash", "restart"] as const)
  test(`a runner ${stop} mid-turn leaves the run to Paws's lost-run recovery`, async () => {
    const f = await fixture();
    try {
      f.event({ type: "progress", text: "working" });
      await f.tick();
      const stopped = f.stopped();
      await f[stop]();
      expect(f.stopped()).toBeGreaterThan(stopped);
      for (let i = 0; i < 5; i++) await f.tick();
      expect(f.posted).toEqual([]);
      expect(f.reports.at(-1)).toEqual([]);
      expect(f.errors.join("\n")).not.toContain("the runner restarted while it was running");
      if (stop === "crash")
        expect(f.errors.join("\n")).toContain("Paws recovers the run from its branch");
    } finally {
      await f.cleanup();
    }
  });

test("a crash after a finished but unpublished turn leaves it to lost-run recovery", async () => {
  const f = await fixture();
  try {
    f.finish();
    await f.crash();
    for (let i = 0; i < 5; i++) await f.tick();
    expect(f.posted).toEqual([]);
    expect(f.reports.at(-1)).toEqual([]);
  } finally {
    await f.cleanup();
  }
});

test("a crash whose worker cannot be stopped fails startup instead of leaving the work out", async () => {
  const f = await fixture();
  try {
    await f.tick();
    const reports = f.reports.length;
    await expect(f.crash(true)).rejects.toThrow("Worker cleanup unavailable");
    expect(f.reports).toHaveLength(reports);
    expect(f.posted).toEqual([]);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a crash after the worker saved an agent error delivers that error unchanged", async () => {
  const f = await fixture();
  try {
    f.finish({ stopReason: "error", errorMessage: "The agent failed." });
    await f.crash();
    await f.tickUntil(() => f.posted.length > 0);
    expect(f.posted).toHaveLength(1);
    expect(f.posted[0]).toMatchObject({ stopReason: "error", errorMessage: "The agent failed." });
  } finally {
    await f.cleanup();
  }
});

test("pending failure remains reported after active cleanup until Paws accepts it", async () => {
  const f = await fixture();
  try {
    f.goDown();
    await f.tick();
    f.advance(RUNNER_OFFLINE_BUDGET_MS + 6 * 60_000);
    await Bun.sleep(300);
    await f.tick();
    f.comeBack();
    f.rejectResults(2);
    await f.tickUntil(() => f.postAttempts() >= 2);
    await f.tickUntil(() => f.posted.length > 0);
    expect(f.posted).toHaveLength(1);
    expect(f.reports.slice(1).every((report) => report.includes("run"))).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("permanent result refusals stop retries across runner restarts", async () => {
  for (const status of [403, 409]) {
    const f = await fixture();
    try {
      f.rejectPermanently(status, "Runner work is fenced.");
      f.finish();
      await f.tickUntil(() => f.postAttempts() > 0);
      for (let i = 0; i < 3; i++) await f.tick();
      const attempts = f.grantAttempts();
      await f.restart();
      for (let i = 0; i < 3; i++) await f.tick();
      expect(f.postAttempts()).toBe(status === 403 ? 2 : 1);
      expect(f.grantAttempts()).toBe(attempts);
      expect(f.errors.filter((error) => error.includes("refused the stored result"))).toHaveLength(
        1,
      );
    } finally {
      await f.cleanup();
    }
  }
});

test("a failure whose transcript was sealed retries only the result after restart", async () => {
  const f = await fixture();
  try {
    f.rejectSealed();
    f.refuse(403, 1);
    f.rejectResults(1);
    await f.tickUntil(() => f.postAttempts() > 0);
    expect(f.seals()).toBe(1);
    await f.restart();
    await f.tickUntil(() => f.posted.length > 0);
    expect(f.seals()).toBe(1);
    expect(f.posted[0]!.stopReason).toBe("error");
  } finally {
    await f.cleanup();
  }
});

test("stored success has one delivery in flight while interruption and retry overlap", async () => {
  const f = await fixture();
  try {
    f.rejectResults(1);
    f.finish();
    await f.tickUntil(() => f.postAttempts() > 0);
    f.holdPost();
    f.missing();
    await f.tick();
    await f.tickUntil(() => f.postAttempts() >= 2);
    await f.tick();
    expect(f.postAttempts()).toBe(2);
    f.releasePost();
    await f.tickUntil(() => f.posted.length > 0);
    expect(f.posted).toHaveLength(1);
  } finally {
    f.releasePost();
    await f.cleanup();
  }
});

test("idle offline time cannot extend the lease beyond Paws's authority ceiling", async () => {
  const f = await fixture();
  try {
    f.goDown();
    await f.tick();
    f.event({
      type: "question",
      requestId: crypto.randomUUID(),
      question: "Continue?",
      options: [],
    });
    await Bun.sleep(300);
    f.advance(2 * RUNNER_OFFLINE_BUDGET_MS);
    await Bun.sleep(300);
    expect(f.stopped()).toBe(1);
    expect(f.posted).toHaveLength(0);
    f.comeBack();
    await f.tickUntil(() => f.posted.length > 0);
    expect(f.posted[0]!.errorMessage).toContain("lease deadline passed");
  } finally {
    await f.cleanup();
  }
});

test("shutdown cannot renew a grant or post a result after an upload stops", async () => {
  const f = await fixture();
  let stopping: Promise<void> | undefined;
  try {
    const finish = f.daemon.finishTranscript;
    f.daemon.finishTranscript = async (...args) => {
      await finish(...args);
      stopping = f.stop();
      throw new RunnerRequestError(403, "POST", "/finish", 1, "Run grant is invalid or expired.");
    };
    f.refuse(403, 1);
    await f.tickUntil(() => stopping !== undefined);
    const grants = f.grantAttempts();
    await stopping;
    expect(f.grantAttempts()).toBe(grants);
    expect(f.posted).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});

test("a lost transcript seal acknowledgement cannot reject the failure result", async () => {
  const f = await fixture();
  try {
    const finish = f.daemon.finishTranscript;
    let lost = false;
    f.rejectSealed();
    f.daemon.finishTranscript = async (...args) => {
      const result = await finish(...args);
      if (!lost) {
        lost = true;
        throw new RunnerRequestError(503, "POST", "/finish", 1);
      }
      return result;
    };
    f.refuse(403, 1);
    await f.tickUntil(() => f.posted.length > 0);
    expect(f.seals()).toBe(1);
    expect(f.posted).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("transient result retries back off and report one repeated failure", async () => {
  for (const status of [503, 400, 401, 403, 404, 410, "parse"]) {
    const f = await fixture({ retryMs: 1000 });
    try {
      if (status === 503) f.rejectResults(100);
      else if (typeof status === "number") f.rejectPermanently(status);
      else {
        const post = f.daemon.postResult;
        f.daemon.postResult = async (...args) => {
          const result = await post(...args);
          RunnerResultSchema.parse({});
          return result;
        };
      }
      f.finish();
      await f.tickUntil(() => f.postAttempts() > 0);
      for (let i = 0; i < 4; i++) await f.tick();
      expect(f.postAttempts()).toBe(status === 403 ? 2 : 1);
      const errors = f.errors.length;
      f.advance(1000);
      await f.tickUntil(() => f.postAttempts() > (status === 403 ? 2 : 1));
      expect(f.postAttempts()).toBe(status === 403 ? 4 : 2);
      expect(f.errors).toHaveLength(errors);
      expect(f.status().active).toBeNull();
      f.advance(2 * RUNNER_OFFLINE_BUDGET_MS);
      await Bun.sleep(300);
      expect(f.errors.join("\n")).not.toContain("Runner interrupted");
    } finally {
      await f.cleanup();
    }
  }
});

test("shutdown bounds an in-flight result and ignores its late response", async () => {
  const f = await fixture({ stopWaitMs: 10 });
  try {
    f.holdPost();
    f.finish();
    await f.tickUntil(() => f.postAttempts() > 0);
    await Promise.race([
      f.stop(),
      Bun.sleep(1000).then(() => {
        throw new Error("Shutdown hung");
      }),
    ]);
    f.releasePost();
    await Bun.sleep(20);
    expect(f.errors.join("\n")).not.toContain("closed");
  } finally {
    f.releasePost();
    await f.cleanup();
  }
});
