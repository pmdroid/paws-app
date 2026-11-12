import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock, JOB_KIND } from "../../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  activateLinearItem,
  applyWorkItemEvent,
  bindLinearSessionTask,
  bindWorkItemRepository,
  ensureLinearSession,
  getJob,
  getLinearSession,
  getWorkItem,
  insertQueuedItem,
  openPawsStore,
  type Db,
} from "../../src/db";
import { Orchestrator } from "../../src/loop";
import { registerScheduler, saveSchedulingContextSteps } from "../../src/scheduler";
import { workspaceAdmission, workspaceDispatchPg } from "../fake-workspace";
import { copyMigratedPglite, tempStore } from "../pglite";

export async function probeSchedulerRuntime(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const clock = new FakeClock(1000);
  const pgliteDir = join(root, "pglite");
  await copyMigratedPglite(pgliteDir);
  let open = await openPawsStore({ url: null, pgliteDir });
  let db = open.store;
  const repository = {
    owner: "owner",
    repo: "repo",
    remoteUrl: "https://example.invalid/repo.git",
  };
  for (const [id, state, position] of [
    ["original", "merge_queue", 0],
    ["blocker", "queued", 1],
  ] as const) {
    await db.run((q) =>
      q.exec(
        q.orm.insert(q.t.workItem).values({
          id,
          delegationId: "epic",
          linearIssueId: id,
          linearIdentifier: id,
          title: id,
          state,
          branchName: `paws/${id}`,
          position,
          createdAt: 1000,
          sessionKey: "session",
        }),
      ),
    );
    await bindWorkItemRepository(db, id, repository);
    await db.run((q) =>
      saveSchedulingContextSteps(q, { itemId: id, projectId: "project", paths: ["src/shared"] }),
    );
  }
  await db.run((q) =>
    q.exec(
      q.orm
        .insert(q.t.taskBlock)
        .values({ blockerLinearIssueId: "blocker", blockedLinearIssueId: "original" }),
    ),
  );
  await ensureLinearSession(db, {
    sessionId: "session",
    issueId: "parent",
    now: clock.now(),
  });
  await bindLinearSessionTask(db, "session", "epic");
  await activateLinearItem(db, "session", "original");
  const heldLoop = new JobLoop(db, clock);
  let heldTicks = 0;
  await registerScheduler(
    heldLoop,
    () => {
      heldTicks += 1;
    },
    clock.now(),
  );
  const firstTick = await heldLoop.tick();
  assert(firstTick);
  observe(
    "the durable custom hook replaces standalone admission while reconciliation is held",
    firstTick.queue === "scheduler.tick" &&
      heldTicks === 1 &&
      (await getLinearSession(db, "session"))?.activeItemId === "original" &&
      (await admissions(db)).length === 0,
    {
      queue: firstTick.queue,
      heldTicks,
      activeItemId: (await getLinearSession(db, "session"))?.activeItemId,
    },
  );
  await open.close();
  clock.advance(30000);
  open = await openPawsStore({ url: null, pgliteDir });
  db = open.store;
  const jobs = new JobLoop(db, clock);
  const events: string[] = [];
  const orchestrator = new Orchestrator({
    store: db,
    admission: workspaceAdmission(db),
    jobs,
    clock,
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: root,
    scheduling: async () => ({}),
  });
  try {
    await registerScheduler(
      jobs,
      async () => {
        events.push(`reconcile:${(await getLinearSession(db, "session"))?.activeItemId}`);
        await orchestrator.reconcileExecution();
      },
      clock.now(),
    );
    const tick = await jobs.tick();
    const [admission] = await admissions(db);
    observe(
      "after restart the same recurring tick yields the merge session and admits the blocker in one dispatch",
      tick?.id === firstTick.id &&
        (await getJob(db, firstTick.id))?.fireCount === 2 &&
        JSON.stringify(events) === JSON.stringify(["reconcile:original"]) &&
        admission?.itemId === "blocker" &&
        (await getLinearSession(db, "session"))?.activeItemId === null,
      {
        tick: tick?.id,
        fireCount: (await getJob(db, firstTick.id))?.fireCount,
        events,
        admission,
      },
    );
    jobs.register(JOB_KIND.start, async (job) => {
      const itemId = (job.payload as { itemId: string }).itemId;
      await activateLinearItem(db, "session", itemId);
      await applyWorkItemEvent(db, itemId, "dispatched");
    });
    const start = await jobs.tick();
    observe(
      "the admitted blocker claims and activates the yielded canonical session",
      start?.queue === JOB_KIND.start &&
        (await getWorkItem(db, "blocker"))?.state === "running" &&
        (await getLinearSession(db, "session"))?.activeItemId === "blocker" &&
        (await getWorkItem(db, "original"))?.state === "merge_queue",
      {
        queue: start?.queue,
        state: (await getWorkItem(db, "blocker"))?.state,
        activeItemId: (await getLinearSession(db, "session"))?.activeItemId,
      },
    );
  } finally {
    await orchestrator.shutdown();
    await open.close();
  }
  const { db: defaults, close } = await tempStore();
  try {
    await insertQueuedItem(defaults, { id: "default", now: clock.now() });
    await bindWorkItemRepository(defaults, "default", repository);
    await defaults.run((q) =>
      saveSchedulingContextSteps(q, {
        itemId: "default",
        projectId: "project",
        paths: ["src/default"],
      }),
    );
    const loop = new JobLoop(defaults, clock);
    const run = () => workspaceDispatchPg(defaults, { now: clock.now() });
    await registerScheduler(
      loop,
      async () => {
        await run();
      },
      clock.now(),
    );
    const tick = await loop.tick();
    const count = (await admissions(defaults)).length;
    observe(
      "without a custom hook the durable tick and returned dispatcher retain default behavior",
      tick?.queue === "scheduler.tick" && count === 1 && (await run()).length === 0,
      { queue: tick?.queue, admissions: count },
    );
  } finally {
    await close();
  }
}

function admissions(db: Db) {
  return db.run((q) =>
    q.all(q.orm.select({ itemId: q.t.schedulerAdmission.itemId }).from(q.t.schedulerAdmission)),
  );
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Provide a disposable proof directory");
  const observations: unknown[] = [];
  await probeSchedulerRuntime(root, (name, passed, observed) => {
    observations.push({ name, passed, observed });
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
    assert(passed, name);
  });
  console.log(JSON.stringify({ root, observations: observations.length }));
}
