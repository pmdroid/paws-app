import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import type { RunAgentOptions, RunAgentResult } from "../src/acp";
import type { Checkpoint } from "../src/core";
import {
  accrueAwake,
  beginImplementRun,
  getRun,
  getUsagePause,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
  recoverOnStartup,
  saveUsagePause,
  setRecoveryAttempts,
} from "../src/db";
import {
  RetryableRunnerError,
  runWithFailover,
  type UsageContinuation,
} from "../src/runner-backend";

const NOW = Date.parse("2026-10-21T17:25:00.000Z");
const HOUR = 3_600_000;

function database(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

function pause(db: Database, itemId: string, resumeAt: number) {
  saveUsagePause(db, {
    itemId,
    role: "implementer",
    agent: "claude",
    runnerId: null,
    accountUserId: null,
    resetsAt: resumeAt,
    resumeAt,
    pausedAt: NOW,
  });
}

test("a usage-limit wait does not count toward the awake-time cap", () => {
  const db = database();
  const item = insertQueuedItem(db, { now: NOW });
  beginImplementRun(db, item.id, NOW);
  accrueAwake(db, item.id, 0, NOW);
  pause(db, item.id, NOW + 5 * HOUR);
  const waited = accrueAwake(db, item.id, 5 * HOUR, NOW + 5 * HOUR);
  expect(waited.capped).toBe(false);
  expect(waited.item).toMatchObject({ state: "running", awakeMs: 0 });
  db.run("DELETE FROM usage_pause");
  expect(accrueAwake(db, item.id, 5 * HOUR + 60_000, NOW).item.awakeMs).toBe(60_000);
});

test("a restart keeps a task waiting for its first placement and queues it again", () => {
  const db = database();
  const item = insertQueuedItem(db, { now: NOW });
  const { run } = beginImplementRun(db, item.id, NOW);
  pause(db, item.id, NOW + HOUR);
  recoverOnStartup(db, NOW);
  expect(getWorkItem(db, item.id)).toMatchObject({ state: "queued", currentRunId: null });
  expect(getRun(db, run.id)?.status).toBe("lost");
  expect(getUsagePause(db, item.id)).toBeNull();
});

test("a restart resumes a paused task with a checkpoint even after an earlier recovery", () => {
  const db = database();
  const checkpoint: Checkpoint = { phase: "running", wipCommit: "wip", baseSha: "base" };
  const item = insertQueuedItem(db, { now: NOW });
  beginImplementRun(db, item.id, NOW, checkpoint);
  setRecoveryAttempts(db, item.id, 1);
  pause(db, item.id, NOW + HOUR);
  expect(recoverOnStartup(db, NOW)).toEqual([{ type: "resume", freshSession: true, checkpoint }]);
  expect(getWorkItem(db, item.id)?.state).toBe("recovering");
  expect(listJobs(db).some((job) => job.queue === "run.resume")).toBe(true);
});

function options(asked: string[]): RunAgentOptions {
  return {
    role: "implementer",
    itemId: "item",
    runId: "run",
    prompt: "Implement",
    worktreePath: "/tmp/none",
    pawsRoot: "/tmp/none",
    askTeam: {
      async ask(request) {
        asked.push(request.question);
        return { answer: "Keep the artifact." };
      },
    },
  };
}

const done: RunAgentResult = {
  role: "implementer",
  stopReason: "end_turn",
  timedOut: false,
  cancelled: false,
  authRequired: false,
  agentExited: true,
};

test("after published effects, a usage limit continues the same session without asking", async () => {
  const asked: string[] = [];
  const seen: (UsageContinuation | undefined)[] = [];
  let calls = 0;
  const result = await runWithFailover(
    options(asked),
    async (_input, excluded, continuation) => {
      seen.push(continuation);
      expect(excluded).toEqual([]);
      if (calls++ === 0)
        throw new RetryableRunnerError("box", "limit", undefined, true, true, "session-1");
      expect(continuation?.runnerId).toBe("box");
      expect(continuation?.sessionId).toBe("session-1");
      return done;
    },
    async () => {},
  );
  expect(result.stopReason).toBe("end_turn");
  expect(asked).toEqual([]);
  expect(typeof seen[1]?.confirmElsewhere).toBe("function");
});

test("after published effects, moving the work to another runner asks first", async () => {
  const asked: string[] = [];
  let calls = 0;
  await runWithFailover(
    options(asked),
    async (_input, _excluded, continuation) => {
      if (calls++ === 0)
        throw new RetryableRunnerError("box", "limit", undefined, true, true, "session-1");
      expect(await continuation?.confirmElsewhere?.()).toBe("Keep the artifact.");
      return done;
    },
    async () => {},
  );
  expect(asked).toHaveLength(1);
});
