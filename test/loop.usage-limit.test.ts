import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "bun:test";
import { runDir, type RunAgentOptions } from "../src/acp";
import { FakeClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  getUsagePause,
  getWorkItem,
  listWorkItems,
  migrate,
  openDatabase,
} from "../src/db";
import { createFakeTracker, type AcceptedLinearEvent } from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import {
  RetryableRunnerError,
  placeOrWait,
  runWithFailover,
  USAGE_RESUME_MARGIN_MS,
} from "../src/runner-backend";
import { quotaSignal } from "../src/runner-placement";

const exec = promisify(execFile);
const START = Date.parse("2026-10-21T17:25:00.000Z");
const RESET = Date.parse("2026-10-21T18:00:00.000Z");
const LIMIT_WITH_RESET = `Claude usage limit reached. Your limit resets at ${new Date(RESET).toISOString()}`;
const LIMIT_WITHOUT_RESET = "insufficient_quota";

type Outcome = { limit: string } | "hang";
type FakeRunner = {
  id: string;
  cooldownUntil: number;
  resetsAt?: number | null;
  outcomes: Outcome[];
};

async function until(predicate: () => boolean, message: string) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error(message);
}

function advanceTo(clock: FakeClock, at: number) {
  clock.advance(at - clock.now());
}

/**
 * The orchestrator with a fake runner backend: placement skips runners whose
 * account cools down, a usage limit sets that cooldown from the agent's error
 * text, and the real failover and pause logic run on a fake clock.
 */
async function fixture(runners: FakeRunner[]) {
  const root = await mkdtemp(path.join(tmpdir(), "paws-usage-limit-"));
  const bare = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const pawsRoot = path.join(root, "paws");
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  await mkdir(pawsRoot, { recursive: true });
  await exec("git", ["init", "--bare", "-b", "main", bare]);
  await exec("git", ["clone", bare, seed]);
  await exec("git", ["-C", seed, "config", "user.email", "paws-test@example.com"]);
  await exec("git", ["-C", seed, "config", "user.name", "Paws Test"]);
  await writeFile(path.join(seed, "README.md"), "demo\n");
  await exec("git", ["-C", seed, "add", "."]);
  await exec("git", ["-C", seed, "commit", "-m", "init"]);
  await exec("git", ["-C", seed, "push", "origin", "HEAD:main"]);
  const db = openDatabase(path.join(pawsRoot, "paws.db"));
  migrate(db);
  const clock = new FakeClock(START);
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-102",
      title: "CSV / JSON formatters",
      description: null,
      subIssues: [],
    },
  ]);
  const attempts: {
    runner: string;
    prompt: string;
    role: string;
    session: string;
    resumedSession?: string;
  }[] = [];
  const agentForItem = (itemId: string) => (options: RunAgentOptions) => {
    const usage: Parameters<typeof placeOrWait>[0]["usage"] = { hook: options.usageLimit };
    return runWithFailover(
      options,
      async (input, excluded, continuation) => {
        const runner = await placeOrWait({
          place: async () =>
            runners.find(
              (entry) => !excluded.includes(entry.id) && entry.cooldownUntil <= clock.now(),
            ) ?? null,
          cooldown: () => {
            const cooling = runners
              .filter((entry) => entry.cooldownUntil > clock.now())
              .sort((left, right) => left.cooldownUntil - right.cooldownUntil)[0];
            return cooling
              ? {
                  runnerId: cooling.id,
                  accountUserId: null,
                  cooldownUntil: cooling.cooldownUntil,
                  resetsAt: cooling.resetsAt ?? null,
                }
              : null;
          },
          unavailable: () => new Error("No available paired runner"),
          db,
          itemId,
          role: input.role,
          agent: input.profile?.agent,
          usage,
          now: () => clock.now(),
          pollMs: 2,
          signal: input.signal,
        });
        // The fake runner keeps a stopped session and loads it when the continuation names it.
        const resumedSession =
          continuation?.runnerId === runner.id ? continuation.sessionId : undefined;
        const session = resumedSession ?? `${runner.id}-session-${attempts.length + 1}`;
        attempts.push({
          runner: runner.id,
          prompt: input.prompt,
          role: input.role,
          session,
          ...(resumedSession ? { resumedSession } : {}),
        });
        const transcript = `${runDir(input.pawsRoot, input.runId)}/acp.jsonl`;
        mkdirSync(path.dirname(transcript), { recursive: true });
        appendFileSync(
          transcript,
          `${JSON.stringify({
            event: {
              type: "session_update",
              sessionId: "s",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: `Work on ${runner.id}, attempt ${attempts.length}.`,
                },
              },
            },
          })}\n`,
        );
        const outcome = runner.outcomes.shift() ?? "hang";
        if (outcome === "hang")
          return await new Promise((_, reject) =>
            input.signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
              once: true,
            }),
          );
        const quota = quotaSignal(outcome.limit, clock.now())!;
        runner.cooldownUntil = quota.cooldownUntil;
        runner.resetsAt = quota.resetsAt;
        usage.resetsAt = quota.resetsAt;
        throw new RetryableRunnerError(
          runner.id,
          "The runner agent exhausted its observed quota.",
          transcript,
          false,
          true,
          session,
        );
      },
      async () => {},
    );
  };
  const orchestrator = attachOrchestrator({
    db,
    clock,
    jobs,
    outbox,
    pawsRoot,
    home,
    tracker,
    repository: { owner: "acme", repo: "platform", remoteUrl: bare },
    launch() {
      return { command: "/forbidden-local-agent", args: [] };
    },
    remoteExecution: {
      async cancelItem() {},
      agentForSession() {
        throw new Error("Unexpected helper dispatch");
      },
      agentForItem,
    },
  });
  const lines = (prefix: string) =>
    tracker.progress.filter((entry) => entry.body.startsWith(prefix)).map((entry) => entry.body);
  let running: Promise<unknown> = Promise.resolve();
  return {
    db,
    clock,
    attempts,
    lines,
    item: () => listWorkItems(db)[0]!,
    async start() {
      await orchestrator.onLinearEvent(event("created"));
      running = jobs.tick();
    },
    async stop() {
      await orchestrator.onLinearEvent({ ...event("prompted"), signal: "stop" });
      await running;
    },
    async close() {
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function event(action: "created" | "prompted"): AcceptedLinearEvent {
  return {
    dedupeKey: action === "created" ? "created:issue" : "activity:stop",
    deliveryId: null,
    source: "webhook",
    action,
    sessionId: "ses_1",
    issueId: "issue",
    activityId: action === "created" ? null : "act-stop",
    actorId: action === "created" ? null : "human-1",
    body: null,
    signal: null,
    updatedAtMs: START + (action === "created" ? 0 : 1_000),
    payload: "{}",
  };
}

test("a usage limit mid-run pauses the task and continues at the reset on the same runner, in the same conversation", async () => {
  const runner: FakeRunner = {
    id: "agentbox",
    cooldownUntil: 0,
    outcomes: [{ limit: LIMIT_WITH_RESET }],
  };
  const run = await fixture([runner]);
  try {
    await run.start();
    await until(() => run.lines("Paused:").length === 1, "The pause was not posted to Linear");
    const itemId = run.item().id;
    expect(getWorkItem(run.db, itemId)?.state).toBe("running");
    expect(run.lines("Paused:")).toEqual([
      "Paused: Claude reached its usage limit. Paws continues at 18:00 UTC.",
    ]);
    expect(getUsagePause(run.db, itemId)?.resumeAt).toBe(RESET + USAGE_RESUME_MARGIN_MS);
    advanceTo(run.clock, RESET + 30_000);
    await Bun.sleep(40);
    expect(run.attempts).toHaveLength(1);
    advanceTo(run.clock, RESET + USAGE_RESUME_MARGIN_MS);
    await until(() => run.attempts.length === 2, "The task did not continue at the reset");
    expect(run.attempts.map((attempt) => attempt.runner)).toEqual(["agentbox", "agentbox"]);
    expect(run.attempts[1]!.resumedSession).toBe(run.attempts[0]!.session);
    expect(run.attempts[1]!.prompt).toContain("stopped at its usage limit");
    expect(run.attempts[1]!.prompt).toContain("Work on agentbox, attempt 1.");
    await until(() => run.lines("Continuing:").length === 1, "The continue line was not posted");
    expect(run.lines("Paused:")).toHaveLength(1);
    expect(getWorkItem(run.db, itemId)?.state).toBe("running");
    expect(getUsagePause(run.db, itemId)).toBeNull();
    await run.stop();
  } finally {
    await run.close();
  }
}, 30_000);

test("without a reset time the task tries again every 15 minutes", async () => {
  const runner: FakeRunner = {
    id: "agentbox",
    cooldownUntil: 0,
    outcomes: [{ limit: LIMIT_WITHOUT_RESET }, { limit: LIMIT_WITHOUT_RESET }],
  };
  const run = await fixture([runner]);
  try {
    await run.start();
    await until(() => getUsagePause(run.db, run.item().id) !== null, "The task did not pause");
    const first = getUsagePause(run.db, run.item().id)!;
    expect(first.resetsAt).toBeNull();
    expect(first.resumeAt).toBe(START + 15 * 60_000);
    expect(run.lines("Paused:")[0]).toContain("Paws tries again at 17:40 UTC.");
    advanceTo(run.clock, first.resumeAt);
    await until(() => run.attempts.length === 2, "The task did not try again");
    await until(
      () => (getUsagePause(run.db, run.item().id)?.pausedAt ?? 0) > first.pausedAt,
      "The second limit did not pause the task",
    );
    expect(getUsagePause(run.db, run.item().id)?.resumeAt).toBe(first.resumeAt + 15 * 60_000);
    advanceTo(run.clock, first.resumeAt + 15 * 60_000);
    await until(() => run.attempts.length === 3, "The task did not try again a second time");
    expect(getWorkItem(run.db, run.item().id)?.state).toBe("running");
    await run.stop();
  } finally {
    await run.close();
  }
}, 30_000);

test("work that cannot start for a usage limit waits for the reset instead of failing", async () => {
  const run = await fixture([
    { id: "agentbox", cooldownUntil: RESET, resetsAt: RESET, outcomes: [] },
  ]);
  try {
    await run.start();
    await until(() => run.lines("Paused:").length === 1, "The waiting task was not paused");
    expect(run.attempts).toHaveLength(0);
    expect(getWorkItem(run.db, run.item().id)?.state).toBe("running");
    advanceTo(run.clock, RESET + USAGE_RESUME_MARGIN_MS);
    await until(() => run.attempts.length === 1, "The task did not start after the reset");
    await run.stop();
  } finally {
    await run.close();
  }
}, 30_000);

test("work that cannot start without a known reset time tries again after 15 minutes", async () => {
  const run = await fixture([
    { id: "agentbox", cooldownUntil: START + 15 * 60_000, resetsAt: null, outcomes: [] },
  ]);
  try {
    await run.start();
    await until(() => getUsagePause(run.db, run.item().id) !== null, "The task did not wait");
    const pause = getUsagePause(run.db, run.item().id)!;
    expect(pause.resetsAt).toBeNull();
    expect(pause.resumeAt).toBe(START + 15 * 60_000);
    advanceTo(run.clock, START + 15 * 60_000);
    await until(() => run.attempts.length === 1, "The task did not try again after 15 minutes");
    await run.stop();
  } finally {
    await run.close();
  }
}, 30_000);

test("a second runner with an available account takes the work without waiting", async () => {
  const run = await fixture([
    { id: "agentbox", cooldownUntil: 0, outcomes: [{ limit: LIMIT_WITH_RESET }] },
    { id: "spare", cooldownUntil: 0, outcomes: [] },
  ]);
  try {
    await run.start();
    await until(() => run.attempts.length === 2, "The second runner did not take the work");
    expect(run.attempts.map((attempt) => attempt.runner)).toEqual(["agentbox", "spare"]);
    expect(run.clock.now()).toBe(START);
    expect(getUsagePause(run.db, run.item().id)).toBeNull();
    expect(run.lines("Paused:")).toHaveLength(0);
    await run.stop();
  } finally {
    await run.close();
  }
}, 30_000);

test("Stop ends the wait", async () => {
  const run = await fixture([
    { id: "agentbox", cooldownUntil: 0, outcomes: [{ limit: LIMIT_WITH_RESET }] },
  ]);
  try {
    await run.start();
    await until(() => getUsagePause(run.db, run.item().id) !== null, "The task did not pause");
    await run.stop();
    expect(getWorkItem(run.db, run.item().id)?.state).toBe("cancelled");
    expect(getUsagePause(run.db, run.item().id)).toBeNull();
    advanceTo(run.clock, RESET + USAGE_RESUME_MARGIN_MS);
    await Bun.sleep(40);
    expect(run.attempts).toHaveLength(1);
  } finally {
    await run.close();
  }
}, 30_000);
