import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { RunAgentOptions, RunAgentResult } from "../src/acp";
import { FakeClock, UsageLimitError } from "../src/core";
import {
  beginImplementRun,
  getUsageLimitPause,
  getWorkItem,
  insertQueuedItem,
  JobLoop,
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
  next: Array<{ limit: number | null } | "ok">;
};

/**
 * A fake remote runner on the real failover path: placement skips accounts in cooldown, a usage
 * limit puts the account in cooldown, and with nobody left the run stops with `UsageLimitError`.
 */
function fakeRemote(clock: FakeClock, runners: FakeRunner[]) {
  const calls: { runner: string; prompt: string; runId: string; at: number }[] = [];
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
        });
        const step = runner.next.shift() ?? "ok";
        if (step !== "ok") {
          runner.cooldownUntil = step.limit ?? clock.now() + 15 * 60_000;
          throw new RetryableRunnerError(
            runner.id,
            "The runner agent exhausted its observed quota.",
            undefined,
            false,
            { agent: "claude", resetsAt: step.limit },
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
  return { db, clock, orchestrator, item, run, remote, controller, prompt };
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
    "Implement PAS-431\n\nContinue in a fresh agent session.",
  );
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
