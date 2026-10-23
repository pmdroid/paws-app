import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { RunAgentOptions, RunAgentResult } from "../src/acp";
import { FakeClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  countLinearRequest,
  insertQueuedItem,
  insertRun,
  linearRequestsByItem,
  listWorkItems,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import {
  createFakeTracker,
  createLinearLedger,
  currentLinearCaller,
  type AcceptedLinearEvent,
  type LinearRateBudget,
} from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { registerScheduler } from "../src/scheduler";
import { tempDb, tempHome } from "./helpers";

const TASKS = 100;
const STARTED = 60;
const QUESTIONS = 10;
const SLOTS = 16;
const STEP_MS = 30_000;
const WAIT_STEP_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
const NO_BUDGET: LinearRateBudget = {
  requestsRemaining: null,
  requestsLimit: null,
  requestsResetMs: null,
  complexityRemaining: null,
  complexityLimit: null,
  complexityResetMs: null,
  complexity: null,
};

test("100 tasks stay under 1,700 Linear requests and spend none while they wait for a runner", async () => {
  const home = tempHome();
  const root = join(home, "paws");
  mkdirSync(root);
  const db = tempDb();
  const clock = new FakeClock(Date.UTC(2026, 9, 23, 9));
  const ledger = createLinearLedger({
    now: () => clock.now(),
    log: () => {},
    countItem: (itemId) => countLinearRequest(db, itemId),
  });
  const runner = seedRunner(db, clock.now());
  let requests = 0;
  const tracker = new Proxy(
    createFakeTracker(
      Array.from({ length: TASKS }, (_, index) => ({
        linearIssueId: `issue-${index}`,
        identifier: `ENG-${index + 1}`,
        title: `Explain part ${index + 1}`,
        description: null,
        subIssues: [],
      })),
    ),
    {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const { caller, item, itemId } = currentLinearCaller();
          requests += 1;
          ledger.observe(caller, NO_BUDGET, item, itemId);
          return value.apply(target, args);
        };
      },
    },
  );
  const asked = new Set<string>();
  const agent =
    (purpose: string) =>
    async (options: RunAgentOptions): Promise<RunAgentResult> => {
      const index = Number(/ENG-(\d+)/.exec(options.prompt)?.[1] ?? 0) - 1;
      let text = purpose === "classify" ? '{"mode":"answer"}' : "Here is the answer.";
      if (purpose !== "classify" && index < QUESTIONS && !asked.has(options.itemId)) {
        asked.add(options.itemId);
        text = (
          await options.askTeam!.ask(
            { question: "Should the answer be a table or a list?" },
            {
              itemId: options.itemId,
              runId: options.runId,
              role: options.role,
              signal: options.signal ?? new AbortController().signal,
            },
          )
        ).answer;
      }
      await options.onEvent?.({
        type: "session_update",
        sessionId: "agent",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
      await options.onEvent?.({ type: "prompt_complete", stopReason: "end_turn" });
      return {
        role: options.role,
        stopReason: "end_turn",
        timedOut: false,
        cancelled: false,
        authRequired: false,
        agentExited: true,
        identity: { session: "agent", model: "test-claude-model", provider: "claude" },
      };
    };
  const jobs = new JobLoop(db, clock);
  const outbox = new OutboxDispatcher(db, clock);
  registerScheduler(jobs, () => orchestrator.reconcileExecution(), clock.now());
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    home,
    pawsRoot: root,
    tracker,
    clock,
    linearTaskModes: true,
    scheduling: () => ({}),
    launch: () => {
      throw new Error("Remote execution must not launch a local agent");
    },
    remoteExecution: {
      slotFree: () => !runner.full(),
      agentForSession: (_sessionId, purpose) => agent(purpose),
      agentForItem: () => agent("answer"),
    },
  });
  const event = (
    index: number,
    action: "created" | "prompted",
    body: string | null = null,
  ): AcceptedLinearEvent => ({
    dedupeKey: `${action}:${index}`,
    deliveryId: null,
    source: "webhook",
    action,
    sessionId: `session-${index}`,
    issueId: `issue-${index}`,
    activityId: action === "prompted" ? `activity-${index}` : null,
    actorId: action === "prompted" ? "human" : null,
    body,
    signal: null,
    updatedAtMs: clock.now(),
    payload: JSON.stringify({ agentSession: { creatorId: "human" } }),
  });
  const tasks = () => listWorkItems(db).filter((item) => item.linearIdentifier.startsWith("ENG-"));
  const count = (state: string) => tasks().filter((item) => item.state === state).length;
  const step = async (ms = STEP_MS) => {
    while ((await jobs.tick()) !== null || outbox.tick().length > 0) await outbox.idle();
    clock.advance(ms);
    runner.seen(clock.now());
  };
  const settle = async (done: () => boolean) => {
    for (let steps = 0; steps < 200 && !done(); steps++) await step();
  };
  try {
    for (let index = 0; index < STARTED; index++)
      await orchestrator.onLinearEvent(event(index, "created"));
    await settle(() => count("completed") + count("awaiting_input") === STARTED);
    runner.fill(clock.now());
    for (let index = STARTED; index < TASKS; index++)
      await orchestrator.onLinearEvent(event(index, "created"));
    await step();
    const queued = count("queued");
    const before = { requests, perTask: linearRequestsByItem(db) };
    for (let waited = 0; waited < HOUR_MS; waited += WAIT_STEP_MS) await step(WAIT_STEP_MS);
    const waiting = {
      queued: count("queued"),
      requests: requests - before.requests,
      perTask: linearRequestsByItem(db),
    };
    runner.free();
    for (let index = 0; index < QUESTIONS; index++)
      await orchestrator.onLinearEvent(event(index, "prompted", "A table."));
    await settle(() => count("completed") === TASKS);
    const perTask = [...linearRequestsByItem(db).values()];
    expect({
      queued,
      waiting,
      asked: asked.size,
      completed: count("completed"),
      counted: perTask.length,
    }).toEqual({
      queued: TASKS - STARTED,
      waiting: { queued: TASKS - STARTED, requests: 0, perTask: before.perTask },
      asked: QUESTIONS,
      completed: TASKS,
      counted: TASKS,
    });
    expect(requests).toBeLessThan(1_700);
    expect(Math.max(...perTask)).toBeLessThanOrEqual(15);
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
    await outbox.idle();
    db.close();
  }
}, 20_000);

function seedRunner(db: Database, now: number) {
  const userId = putWorkspaceUser(db, {
    id: "user-1",
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  db.run("INSERT INTO workspace VALUES(?,?,?,?)", ["ws-1", "org-1", "Workspace", 0]);
  syncWorkspaceMember(db, {
    workspaceId: "ws-1",
    userId,
    role: "owner",
    active: true,
    teamIds: [],
    now: 0,
  });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('runner','ws-1',?,'runner','active',0,?)",
    [userId, now],
  );
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES('runner',?)", [SLOTS]);
  const busy = () =>
    db
      .query<{ n: number }, []>("SELECT count(*) AS n FROM runner_work WHERE ended_at IS NULL")
      .get()!.n;
  return {
    full: () => busy() >= SLOTS,
    seen: (at: number) => db.run("UPDATE runner SET last_seen_at=?", [at]),
    fill(at: number) {
      for (let slot = 0; slot < SLOTS; slot++) {
        const item = insertQueuedItem(db, { id: `other-${slot}`, now: at });
        const run = insertRun(db, { itemId: item.id, now: at, status: "active" });
        db.run(
          "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,'runner','ws-1',1,0,?,?)",
          [run.id, `other-${slot}`, at + 10 * HOUR_MS],
        );
      }
    },
    free() {
      db.run("UPDATE runner_work SET ended_at=1");
      db.run("UPDATE run SET status='ended' WHERE item_id LIKE 'other-%'");
      db.run("UPDATE work_item SET state='cancelled' WHERE id LIKE 'other-%'");
    },
  };
}
