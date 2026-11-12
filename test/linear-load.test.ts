import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { count as countRows, isNull, like } from "drizzle-orm";
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
  type Db,
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
import { tempHome } from "./helpers";
import { workspaceAdmission } from "./fake-workspace";
import { tempStore } from "./pglite";

const TASKS = 100;
const QUESTIONS = 10;
const SLOTS = 16;
// One runner's worth of tasks waits; the rest run first.
const STARTED = TASKS - SLOTS;
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

test("100 tasks stay under 1,700 Linear requests and spend one per 25 minutes while they wait for a runner", async () => {
  const home = tempHome();
  const root = join(home, "paws");
  mkdirSync(root);
  const { db, close } = await tempStore();
  const clock = new FakeClock(Date.UTC(2026, 9, 23, 9));
  const ledger = createLinearLedger({
    now: () => clock.now(),
    log: () => {},
    countItem: async (itemId, caller) => await countLinearRequest(db, itemId, caller),
  });
  const runner = await seedRunner(db, clock.now());
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
  await registerScheduler(jobs, () => orchestrator.reconcileExecution(), clock.now());
  const orchestrator = attachOrchestrator({
    store: db,
    admission: workspaceAdmission(db),
    jobs,
    outbox,
    home,
    pawsRoot: root,
    tracker,
    clock,
    linearTaskModes: true,
    scheduling: async () => ({}),
    launch: () => {
      throw new Error("Remote execution must not launch a local agent");
    },
    remoteExecution: {
      slotFree: async () => !(await runner.full()),
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
  const tasks = async () =>
    (await listWorkItems(db)).filter((item) => item.linearIdentifier.startsWith("ENG-"));
  const count = async (state: string) =>
    (await tasks()).filter((item) => item.state === state).length;
  const step = async (ms = STEP_MS) => {
    while ((await jobs.tick()) !== null || (await outbox.tick()).length > 0) await outbox.idle();
    clock.advance(ms);
    await runner.seen(clock.now());
  };
  const settle = async (done: () => Promise<boolean>) => {
    for (let steps = 0; steps < 200 && !(await done()); steps++) await step();
  };
  try {
    // Tasks arrive a runner's worth at a time: every dispatch scans the whole queue.
    for (let start = 0; start < STARTED; start += SLOTS) {
      const end = Math.min(start + SLOTS, STARTED);
      for (let index = start; index < end; index++)
        await orchestrator.onLinearEvent(event(index, "created"));
      await settle(
        async () => (await count("completed")) + (await count("awaiting_input")) === end,
      );
    }
    await runner.fill(clock.now());
    for (let index = STARTED; index < TASKS; index++)
      await orchestrator.onLinearEvent(event(index, "created"));
    await step();
    const queued = await count("queued");
    const before = { requests, perTask: await linearRequestsByItem(db) };
    for (let waited = 0; waited < HOUR_MS; waited += WAIT_STEP_MS) await step(WAIT_STEP_MS);
    const after = await linearRequestsByItem(db);
    const waiting = {
      queued: await count("queued"),
      requests: requests - before.requests,
      // A waiting task's only Linear request is its "still in line" ephemeral at minutes 25 and 50.
      spent: new Set(
        [...after].map(([itemId, spent]) => spent - (before.perTask.get(itemId) ?? 0)),
      ),
    };
    await runner.free();
    for (let index = 0; index < QUESTIONS; index++)
      await orchestrator.onLinearEvent(event(index, "prompted", "A table."));
    await settle(async () => (await count("completed")) === TASKS);
    const perTask = [...(await linearRequestsByItem(db)).values()];
    expect({
      queued,
      waiting,
      asked: asked.size,
      completed: await count("completed"),
      counted: perTask.length,
    }).toEqual({
      queued: TASKS - STARTED,
      waiting: {
        queued: TASKS - STARTED,
        requests: 2 * (TASKS - STARTED),
        spent: new Set([0, 2]),
      },
      asked: QUESTIONS,
      completed: TASKS,
      counted: TASKS,
    });
    expect(requests).toBeLessThan(1_700);
    expect(Math.max(...perTask)).toBeLessThanOrEqual(15);
  } finally {
    await orchestrator.shutdown().catch(() => undefined);
    await outbox.idle();
    await close();
  }
}, 180_000);

async function seedRunner(db: Db, now: number) {
  const userId = await putWorkspaceUser(db, {
    id: "user-1",
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  await db.run((q) =>
    q.exec(
      q.orm
        .insert(q.t.workspace)
        .values({ id: "ws-1", linearOrganizationId: "org-1", name: "Workspace", createdAt: 0 }),
    ),
  );
  await syncWorkspaceMember(db, {
    workspaceId: "ws-1",
    userId,
    role: "admin",
    active: true,
    teamIds: [],
    now: 0,
  });
  await db.run(function* (q) {
    yield* q.exec(
      q.orm.insert(q.t.runner).values({
        id: "runner",
        workspaceId: "ws-1",
        ownerUserId: userId,
        name: "runner",
        status: "active",
        createdAt: 0,
        lastSeenAt: now,
      }),
    );
    yield* q.exec(q.orm.insert(q.t.runnerCapacity).values({ runnerId: "runner", capacity: SLOTS }));
  });
  const busy = async () =>
    (
      await db.run((q) =>
        q.all(
          q.orm
            .select({ n: countRows() })
            .from(q.t.runnerWork)
            .where(isNull(q.t.runnerWork.endedAt)),
        ),
      )
    )[0]!.n;
  return {
    full: async () => (await busy()) >= SLOTS,
    seen: (at: number) => db.run((q) => q.exec(q.orm.update(q.t.runner).set({ lastSeenAt: at }))),
    async fill(at: number) {
      for (let slot = 0; slot < SLOTS; slot++) {
        const item = await insertQueuedItem(db, { id: `other-${slot}`, now: at });
        const run = await insertRun(db, { itemId: item.id, now: at, status: "active" });
        await db.run((q) =>
          q.exec(
            q.orm.insert(q.t.runnerWork).values({
              runId: run.id,
              runnerId: "runner",
              workspaceId: "ws-1",
              generation: 1,
              runnerFence: 0,
              commandId: `other-${slot}`,
              leaseUntil: at + 10 * HOUR_MS,
            }),
          ),
        );
      }
    },
    free: () =>
      db.run(function* (q) {
        yield* q.exec(q.orm.update(q.t.runnerWork).set({ endedAt: 1, teardownConfirmedAt: 1 }));
        yield* q.exec(
          q.orm.update(q.t.run).set({ status: "ended" }).where(like(q.t.run.itemId, "other-%")),
        );
        yield* q.exec(
          q.orm
            .update(q.t.workItem)
            .set({ state: "cancelled" })
            .where(like(q.t.workItem.id, "other-%")),
        );
      }),
  };
}
