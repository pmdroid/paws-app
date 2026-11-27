import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  beginImplementRun,
  insertQueuedItem,
  markRun,
  syncSteps,
  type Db,
  type JobContext,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import { Orchestrator } from "../src/loop";
import { tempStore } from "./pglite";

type Live = { controller: AbortController; finish(): void };
type Internals = {
  beginLive(itemId: string, key: string): Promise<Live>;
  endLive(key: string, live: Live): void;
  jobContexts: Map<string, JobContext>;
};

let root: string;
let db: Db;
let close: () => Promise<void>;
let orchestrator: Orchestrator;
let lines: string[];

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "paws-live-release-"));
  ({ db, close } = await tempStore());
  const clock = new FakeClock(1_000);
  lines = [];
  orchestrator = new Orchestrator({
    store: db,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: root,
    tracker: createFakeTracker(),
    journal: (line) => lines.push(line),
  });
});

afterEach(async () => {
  await orchestrator.shutdown();
  await close();
  rmSync(root, { recursive: true, force: true });
});

const internals = () => orchestrator as unknown as Internals;

async function lostRunWithLiveOperation() {
  await insertQueuedItem(db, { id: "task", sessionKey: "session", now: 1_000 });
  const { run } = await beginImplementRun(db, "task", 1_000);
  const stale = await internals().beginLive("task", run.id);
  await markRun(db, run.id, "lost", 2_000);
  return { runId: run.id, stale };
}

test("a lost run releases its live operation and the next start succeeds", async () => {
  const { runId, stale } = await lostRunWithLiveOperation();
  await markRun(db, runId, "active", 3_000);
  await expect(internals().beginLive("task", runId)).rejects.toThrow(
    "Run already has an owned live operation",
  );
  await markRun(db, runId, "lost", 4_000);
  const next = await internals().beginLive("task", runId);
  expect(stale.controller.signal.aborted).toBe(true);
  expect(next.controller.signal.aborted).toBe(false);
  expect(orchestrator.agentAlive(runId)).toBe(true);
  expect(lines).toContain(`item task live operation ${runId} released: its run is lost`);
  internals().endLive(runId, next);
});

test("the sweep releases a latched operation whose job no longer runs", async () => {
  await insertQueuedItem(db, { id: "task", sessionKey: "session", now: 1_000 });
  const { run } = await beginImplementRun(db, "task", 1_000);
  let current = true;
  const job: JobContext = {
    signal: new AbortController().signal,
    isCurrent: async () => current,
    isCurrentSteps: () => syncSteps(() => current),
    extendLease: async () => current,
  };
  internals().jobContexts.set("task", job);
  const latched = await internals().beginLive("task", run.id);
  await orchestrator.releaseStaleOperations();
  expect(orchestrator.agentAlive(run.id)).toBe(true);
  current = false;
  internals().jobContexts.delete("task");
  await orchestrator.releaseStaleOperations();
  expect(orchestrator.agentAlive(run.id)).toBe(false);
  expect(latched.controller.signal.aborted).toBe(true);
  expect(lines.filter((line) => line.includes("released"))).toEqual([
    `item task live operation ${run.id} released: its job no longer runs`,
  ]);
});

test("a late finish from the lost run does not take the operation back", async () => {
  const { runId, stale } = await lostRunWithLiveOperation();
  await orchestrator.releaseStaleOperations();
  await markRun(db, runId, "active", 3_000);
  const next = await internals().beginLive("task", runId);
  internals().endLive(runId, stale);
  expect(orchestrator.agentAlive(runId)).toBe(true);
  await orchestrator.releaseStaleOperations();
  expect(orchestrator.agentAlive(runId)).toBe(true);
  internals().endLive(runId, next);
  expect(orchestrator.agentAlive(runId)).toBe(false);
});
