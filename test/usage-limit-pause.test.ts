import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { RunAgentOptions, RunAgentResult } from "../src/acp";
import { FakeClock, UsageLimitError } from "../src/core";
import {
  beginImplementRun,
  getUsageLimitContinuation,
  getUsageLimitPause,
  getWorkItem,
  saveUsageLimitContinuation,
  insertQueuedItem,
  JobLoop,
  listJobs,
  prepareShutdown,
  recoverOnStartup,
  resumeUsageLimitPauseNow,
  saveCheckpoint,
  saveUsageLimitPause,
  setRecoveryAttempts,
  migrate,
  openDatabase,
  OutboxDispatcher,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import { Orchestrator } from "../src/loop";
import { RetryableRunnerError, runWithFailover } from "../src/runner-backend/failover";

const RESET = Date.parse("2026-10-21T18:00:00.000Z");
const START = Date.parse("2026-10-21T15:00:00.000Z");
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type FakeRunner = {
  id: string;
  /** The account's cooldown. Placement skips the runner until then. */
  cooldownUntil: number;
  /** What the next prompt on this runner does. */
  next: Array<{ limit: number | null; published?: boolean; chatter?: boolean } | "ok">;
};

/**
 * A fake remote runner on the real failover path: placement skips accounts in cooldown, a usage
 * limit puts the account in cooldown, and with nobody left the run stops with `UsageLimitError`.
 */
function fakeRemote(clock: FakeClock, runners: FakeRunner[]) {
  const calls: {
    runner: string;
    prompt: string;
    runId: string;
    at: number;
    session?: RunAgentOptions["runnerSession"];
  }[] = [];
  const run = (input: RunAgentOptions) =>
    runWithFailover(
      input,
      async (attempt, excluded): Promise<RunAgentResult> => {
        const runner = runners.find(
          (entry) => !excluded.includes(entry.id) && entry.cooldownUntil <= clock.now(),
        );
        if (!runner)
          throw new UsageLimitError(
            "claude",
            Math.min(...runners.map((entry) => entry.cooldownUntil)) > clock.now()
              ? Math.min(...runners.map((entry) => entry.cooldownUntil))
              : null,
          );
        calls.push({
          runner: runner.id,
          prompt: attempt.prompt,
          runId: attempt.runId,
          at: clock.now(),
          ...(attempt.runnerSession ? { session: attempt.runnerSession } : {}),
        });
        const step = runner.next.shift() ?? "ok";
        if (step !== "ok") {
          // The agent can print its usage-limit error as message text before the run fails.
          if (step.chatter)
            await attempt.onEvent?.({
              type: "session_update",
              sessionId: "s",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "You've hit your usage limit." },
              },
            });
          runner.cooldownUntil = step.limit ?? clock.now() + 15 * 60_000;
          throw new RetryableRunnerError(
            runner.id,
            "The runner agent exhausted its observed quota.",
            undefined,
            step.published ?? false,
            {
              agent: "claude",
              resetsAt: step.limit,
              sessionId: `${runner.id}-session-${calls.length}`,
            },
          );
        }
        await attempt.onEvent?.({ type: "prompt_complete", stopReason: "end_turn" });
        return {
          role: attempt.role,
          stopReason: "end_turn",
          timedOut: false,
          cancelled: false,
          authRequired: false,
          agentExited: true,
        };
      },
      async () => {},
    );
  return { calls, run };
}

function setup(runners: FakeRunner[]) {
  const root = mkdtempSync(join(tmpdir(), "paws-usage-limit-"));
  const db = openDatabase(join(root, "paws.db"));
  migrate(db);
  const clock = new FakeClock(START);
  const item = insertQueuedItem(db, { id: "item-1", sessionKey: "session-1", now: START });
  const run = beginImplementRun(db, item.id, START).run;
  const remote = fakeRemote(clock, runners);
  const orchestrator = new Orchestrator({
    db,
    clock,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: root,
    tracker: createFakeTracker(),
    dispatchReady() {},
    usageLimitPollMs: 1,
    remoteExecution: {
      agentForItem: () => remote.run,
      agentForSession: () => {
        throw new Error("Unexpected helper");
      },
    },
  });
  cleanups.push(async () => {
    await orchestrator.shutdown();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const agent = orchestrator["remoteAgentForItem"](item.id)!;
  const controller = new AbortController();
  const prompt = (text = "Implement PAS-431") =>
    agent({
      role: "implementer",
      itemId: item.id,
      runId: run.id,
      prompt: text,
      worktreePath: root,
      pawsRoot: root,
      signal: controller.signal,
    });
  return { db, clock, orchestrator, item, run, remote, controller, prompt, agent, root };
}

function linearLines(db: Database): string[] {
  return db
    .query<{ payload: string }, []>(
      "SELECT payload FROM outbox WHERE target='linear' AND op='activity' ORDER BY rowid",
    )
    .all()
    .map((row) => (JSON.parse(row.payload) as { body: string }).body);
}

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 2000; attempt++) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error("Condition was not reached");
}

test("a usage limit mid-run pauses the task with one Linear line and continues the same conversation at the reset", async () => {
  const runner = { id: "agentbox", cooldownUntil: 0, next: [{ limit: RESET }] };
  const { db, clock, item, run, remote, prompt } = setup([runner]);
  let finished = false;
  const result = prompt().finally(() => (finished = true));
  await until(() => getUsageLimitPause(db, item.id) !== null);
  expect(getWorkItem(db, item.id)!.state).toBe("running");
  expect(getUsageLimitPause(db, item.id)).toMatchObject({
    agent: "claude",
    runnerId: "agentbox",
    resetsAt: RESET,
    resumeAt: RESET + 60_000,
  });
  expect(linearLines(db)).toEqual([
    "Paused: Claude reached its usage limit. Paws continues at 18:00 UTC.",
  ]);

  clock.advance(RESET - START);
  await Bun.sleep(20);
  expect(remote.calls).toHaveLength(1);
  expect(finished).toBe(false);

  clock.advance(60_000);
  expect((await result).stopReason).toBe("end_turn");
  expect(remote.calls.map((call) => [call.runner, call.at, call.runId])).toEqual([
    ["agentbox", START, run.id],
    ["agentbox", RESET + 60_000, run.id],
  ]);
  expect(remote.calls[1]!.prompt).toStartWith(
    "Implement PAS-431\n\nThe agent stopped at its usage limit. Continue the task where it stopped.",
  );
  expect(remote.calls[0]!.session).toBeUndefined();
  expect(remote.calls[1]!.session).toEqual({
    runnerId: "agentbox",
    sessionId: "agentbox-session-1",
  });
  expect(getUsageLimitPause(db, item.id)).toBeNull();
  expect(linearLines(db)).toEqual([
    "Paused: Claude reached its usage limit. Paws continues at 18:00 UTC.",
    "Continuing: Claude is available again. Paws continues the task.",
  ]);
});

test("without a reset time the task tries again every 15 minutes", async () => {
  const runner = { id: "agentbox", cooldownUntil: 0, next: [{ limit: null }, { limit: null }] };
  const { db, clock, remote, prompt } = setup([runner]);
  const result = prompt();
  for (const step of [1, 2, 3]) {
    await until(() => remote.calls.length === step);
    if (step < 3) {
      await Bun.sleep(5);
      clock.advance(15 * 60_000);
    }
  }
  await result;
  expect(remote.calls.map((call) => call.at - START)).toEqual([0, 15 * 60_000, 30 * 60_000]);
  expect(linearLines(db)).toEqual([
    "Paused: Claude reached its usage limit. Paws tries again every 15 minutes.",
    "Continuing: Claude is available again. Paws continues the task.",
  ]);
});

test("work that cannot start because of a usage limit waits for the reset instead of failing", async () => {
  const runner = { id: "agentbox", cooldownUntil: RESET, next: [] };
  const { db, clock, item, remote, prompt } = setup([runner]);
  const result = prompt();
  await until(() => getUsageLimitPause(db, item.id) !== null);
  expect(remote.calls).toHaveLength(0);
  expect(getUsageLimitPause(db, item.id)).toMatchObject({ runnerId: null, resetsAt: RESET });
  clock.advance(RESET + 60_000 - START);
  await result;
  expect(remote.calls.map((call) => call.prompt)).toEqual(["Implement PAS-431"]);
  expect(getWorkItem(db, item.id)!.state).toBe("running");
});

test("a second runner with an available account takes the work without waiting", async () => {
  const limited = { id: "agentbox", cooldownUntil: 0, next: [{ limit: RESET }] };
  const spare = { id: "sparebox", cooldownUntil: 0, next: [] };
  const { db, item, remote, prompt } = setup([limited, spare]);
  await prompt();
  expect(remote.calls.map((call) => [call.runner, call.at])).toEqual([
    ["agentbox", START],
    ["sparebox", START],
  ]);
  expect(getUsageLimitPause(db, item.id)).toBeNull();
  expect(linearLines(db)).toEqual([]);
});

test("a usage limit leaves the runner eligible once its account resets", async () => {
  const runner = { id: "agentbox", cooldownUntil: 0, next: [{ limit: START + 1 }] };
  const { clock, remote, prompt } = setup([runner]);
  const result = prompt();
  await until(() => remote.calls.length === 1);
  await Bun.sleep(5);
  clock.advance(61_000);
  await result;
  expect(remote.calls.map((call) => call.runner)).toEqual(["agentbox", "agentbox"]);
});

test("Stop ends the wait", async () => {
  const runner = { id: "agentbox", cooldownUntil: 0, next: [{ limit: RESET }] };
  const { db, item, remote, controller, prompt } = setup([runner]);
  const result = prompt();
  await until(() => getUsageLimitPause(db, item.id) !== null);
  controller.abort(new Error("cancelled"));
  await expect(result).rejects.toThrow("cancelled");
  expect(remote.calls).toHaveLength(1);
  expect(getUsageLimitPause(db, item.id)).toBeNull();
  expect(linearLines(db)).toHaveLength(1);
});

test("a shutdown keeps the wait so the next start continues it", async () => {
  const runner = { id: "agentbox", cooldownUntil: 0, next: [{ limit: RESET }] };
  const { db, orchestrator, item, controller, prompt } = setup([runner]);
  saveCheckpoint(db, item.id, { phase: "running", baseSha: "a".repeat(40) });
  setRecoveryAttempts(db, item.id, 1);
  const result = prompt();
  await until(() => getUsageLimitPause(db, item.id) !== null);
  await orchestrator.shutdown();
  controller.abort(new Error("cancelled"));
  await result.catch(() => undefined);
  expect(getUsageLimitPause(db, item.id)).not.toBeNull();
  expect(getUsageLimitContinuation(db, item.id)).toMatchObject({
    runKey: expect.stringMatching(/^implementer:/),
    prompt: expect.stringContaining("The agent stopped at its usage limit."),
    session: { runnerId: "agentbox", sessionId: "agentbox-session-1" },
  });
  prepareShutdown(db, START + 1000);
  recoverOnStartup(db, START + 2000);
  expect(getWorkItem(db, item.id)).toMatchObject({ state: "recovering", recoveryAttempts: 1 });
  expect(getUsageLimitPause(db, item.id)).toMatchObject({ resetsAt: RESET });
});

test("Resume now ends the wait early", async () => {
  const runner = { id: "agentbox", cooldownUntil: 0, next: [{ limit: RESET }] };
  const { db, orchestrator, item, remote, prompt } = setup([runner]);
  const result = prompt();
  await until(() => getUsageLimitPause(db, item.id) !== null);
  runner.cooldownUntil = 0;
  expect(await orchestrator.resumeUsageLimit(item.id)).toBe(true);
  await result;
  expect(remote.calls.map((call) => call.at)).toEqual([START, START]);
  expect(await orchestrator.resumeUsageLimit(item.id)).toBe(false);
});

test("a usage limit after the agent published an artifact still pauses without asking anyone", async () => {
  const runner = { id: "agentbox", cooldownUntil: 0, next: [{ limit: RESET, published: true }] };
  const { db, clock, item, remote, prompt } = setup([runner]);
  const result = prompt();
  await until(() => getUsageLimitPause(db, item.id) !== null);
  clock.advance(RESET + 60_000 - START);
  expect((await result).stopReason).toBe("end_turn");
  expect(remote.calls).toHaveLength(2);
});

test("a paused task continues at the earliest reset of any eligible account", async () => {
  const early = Date.parse("2026-10-21T17:00:00.000Z");
  const limited = { id: "agentbox", cooldownUntil: 0, next: [{ limit: RESET }] };
  const other = { id: "sparebox", cooldownUntil: early, next: [] };
  const { db, item, prompt, controller } = setup([limited, other]);
  const result = prompt();
  await until(() => getUsageLimitPause(db, item.id) !== null);
  expect(getUsageLimitPause(db, item.id)).toMatchObject({
    resetsAt: early,
    resumeAt: early + 60_000,
  });
  controller.abort(new Error("cancelled"));
  await result.catch(() => undefined);
});

test("a restart keeps a usage-limit wait instead of failing it or using the restart resume", () => {
  const root = mkdtempSync(join(tmpdir(), "paws-usage-limit-"));
  const db = openDatabase(join(root, "paws.db"));
  migrate(db);
  cleanups.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const pause = (itemId: string, runId: string) =>
    saveUsageLimitPause(db, {
      itemId,
      runId,
      agent: "claude",
      runnerId: null,
      resetsAt: RESET,
      resumeAt: RESET + 60_000,
      pausedAt: START,
    });
  const fresh = insertQueuedItem(db, { id: "fresh", sessionKey: "session-fresh", now: START });
  pause(fresh.id, beginImplementRun(db, fresh.id, START).run.id);
  const started = insertQueuedItem(db, {
    id: "started",
    sessionKey: "session-started",
    now: START,
  });
  pause(started.id, beginImplementRun(db, started.id, START).run.id);
  saveCheckpoint(db, started.id, { phase: "running", baseSha: "a".repeat(40) });
  setRecoveryAttempts(db, started.id, 1);
  recoverOnStartup(db, START + 1000);
  expect(getWorkItem(db, fresh.id)).toMatchObject({ state: "queued", currentRunId: null });
  expect(getWorkItem(db, started.id)).toMatchObject({ state: "recovering", recoveryAttempts: 1 });
  expect(listJobs(db).some((job) => JSON.stringify(job.payload).includes('"started"'))).toBe(true);
  expect(getUsageLimitPause(db, fresh.id)).not.toBeNull();
  expect(getUsageLimitPause(db, started.id)).not.toBeNull();
  expect(pause(started.id, "another-run")).toBe(false);
});

test("Resume now lifts cooldowns only on runners the task can use", () => {
  const { db, item } = setup([]);
  db.run("PRAGMA foreign_keys=OFF");
  db.run(
    "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('ws','org','Ours',0),('other','org-2','Theirs',0)",
  );
  db.run(
    "INSERT INTO linear_session(session_id,organization_id,created_at) VALUES('session-1','org',0) ON CONFLICT(session_id) DO UPDATE SET organization_id='org'",
  );
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES('ours','ws','u','ours','active',0),('theirs','other','u','theirs','active',0)",
  );
  db.run(
    "INSERT INTO runner_agent_policy(runner_id,agent,cooldown_until) VALUES('ours','claude',?1),('theirs','claude',?1)",
    [RESET],
  );
  saveUsageLimitPause(db, {
    itemId: item.id,
    runId: "run",
    agent: "claude",
    runnerId: null,
    resetsAt: RESET,
    resumeAt: RESET + 60_000,
    pausedAt: START,
  });
  expect(resumeUsageLimitPauseNow(db, item.id, START)).toBe(true);
  const cooldowns = db
    .query<{ id: string; until: number }, []>(
      "SELECT runner_id AS id,cooldown_until AS until FROM runner_agent_policy ORDER BY runner_id",
    )
    .all();
  expect(cooldowns).toEqual([
    { id: "ours", until: 0 },
    { id: "theirs", until: RESET },
  ]);
});

test("after a restart the task still waits for its resume time and continues the saved conversation and session", async () => {
  const runner = { id: "agentbox", cooldownUntil: 0, next: [] };
  const { db, clock, item, run, remote, prompt } = setup([runner]);
  saveUsageLimitPause(db, {
    itemId: item.id,
    runId: run.id,
    agent: "claude",
    runnerId: "agentbox",
    resetsAt: RESET,
    resumeAt: RESET + 60_000,
    pausedAt: START,
  });
  saveUsageLimitContinuation(db, {
    itemId: item.id,
    runKey: `implementer:${run.id}`,
    prompt: "Implement PAS-431\n\nObserved prior conversation: WORKING ON IT",
    session: { runnerId: "agentbox", sessionId: "earlier-session" },
  });
  clock.advance(RESET - START);
  const result = prompt("Resume after the restart");
  await Bun.sleep(20);
  expect(remote.calls).toHaveLength(0);
  clock.advance(60_000);
  await result;
  expect(remote.calls).toHaveLength(1);
  expect(remote.calls[0]!.at).toBe(RESET + 60_000);
  expect(remote.calls[0]!.prompt).toContain("WORKING ON IT");
  expect(remote.calls[0]!.prompt).toEndWith("Resume after the restart");
  expect(remote.calls[0]!.session).toEqual({ runnerId: "agentbox", sessionId: "earlier-session" });
  expect(getUsageLimitPause(db, item.id)).toBeNull();
  expect(getUsageLimitContinuation(db, item.id)).toBeNull();
});

test("a preflight probe after a restart ends the wait but leaves the implementation's continuation", async () => {
  const runner = { id: "agentbox", cooldownUntil: 0, next: [] };
  const { db, clock, item, run, remote, prompt, agent, root, controller } = setup([runner]);
  saveUsageLimitPause(db, {
    itemId: item.id,
    runId: run.id,
    agent: "claude",
    runnerId: "agentbox",
    resetsAt: RESET,
    resumeAt: RESET + 60_000,
    pausedAt: START,
  });
  saveUsageLimitContinuation(db, {
    itemId: item.id,
    runKey: `implementer:${run.id}`,
    prompt: "Implement PAS-431\n\nObserved prior conversation: WORKING ON IT",
    session: { runnerId: "agentbox", sessionId: "earlier-session" },
  });
  clock.advance(RESET + 60_000 - START);
  await agent({
    role: "implementer",
    itemId: item.id,
    runId: `${run.id}-preflight-implementer`,
    prompt: "",
    prepareOnly: true,
    worktreePath: root,
    pawsRoot: root,
    signal: controller.signal,
  });
  expect(getUsageLimitPause(db, item.id)).toBeNull();
  expect(getUsageLimitContinuation(db, item.id)).not.toBeNull();
  await prompt("Resume after the restart");
  expect(remote.calls.at(-1)!.prompt).toContain("WORKING ON IT");
  expect(remote.calls.at(-1)!.session).toEqual({
    runnerId: "agentbox",
    sessionId: "earlier-session",
  });
});

test("a reviewer retried after a restart continues its saved review, a new review does not", async () => {
  const runner = { id: "agentbox", cooldownUntil: 0, next: [] };
  const { db, item, remote, agent, root, controller } = setup([runner]);
  const review = (runId: string, text: string) =>
    agent({
      role: "reviewer",
      itemId: item.id,
      runId,
      prompt: text,
      readOnly: true,
      worktreePath: root,
      pawsRoot: root,
      signal: controller.signal,
    });
  const saved = {
    itemId: item.id,
    runKey: `reviewer:rev-${item.id}`,
    prompt: "Review head abc\n\nObserved prior conversation: HALF THE REVIEW",
    session: { runnerId: "agentbox", sessionId: "review-session" },
  };
  saveUsageLimitContinuation(db, saved);
  await review(`rev-${item.id}-1`, "Review head def");
  expect(remote.calls.at(-1)!.prompt).toBe("Review head def");
  expect(remote.calls.at(-1)!.session).toBeUndefined();
  saveUsageLimitContinuation(db, saved);
  await review(`rev-${item.id}-1`, "Review head abc");
  expect(remote.calls.at(-1)!.prompt).toBe(saved.prompt);
  expect(remote.calls.at(-1)!.session).toEqual(saved.session);
  expect(getUsageLimitContinuation(db, item.id)).toBeNull();
});

test("usage-limit text from a retry that hits the limit again does not end the pause", async () => {
  const later = RESET + 3_600_000;
  const runner = {
    id: "agentbox",
    cooldownUntil: 0,
    next: [{ limit: RESET }, { limit: later, chatter: true }],
  };
  const { db, clock, item, remote, prompt } = setup([runner]);
  const result = prompt();
  await until(() => getUsageLimitPause(db, item.id) !== null);
  clock.advance(RESET + 60_000 - START);
  await until(() => remote.calls.length === 2);
  await until(() => getUsageLimitPause(db, item.id)?.resetsAt === later);
  expect(linearLines(db)).toEqual([
    "Paused: Claude reached its usage limit. Paws continues at 18:00 UTC.",
  ]);
  clock.advance(later - RESET);
  await result;
  expect(linearLines(db)).toEqual([
    "Paused: Claude reached its usage limit. Paws continues at 18:00 UTC.",
    "Continuing: Claude is available again. Paws continues the task.",
  ]);
});
