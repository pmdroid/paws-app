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
  migrate,
  openDatabase,
} from "../../src/db";
import { Orchestrator } from "../../src/loop";
import { dispatch, registerScheduler, saveSchedulingContext } from "../../src/scheduler";

export async function probeSchedulerRuntime(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const clock = new FakeClock(1000);
  const databasePath = join(root, "paws.sqlite");
  let db = openDatabase(databasePath);
  migrate(db);
  const repository = {
    owner: "owner",
    repo: "repo",
    remoteUrl: "https://example.invalid/repo.git",
  };
  for (const [id, state, position] of [
    ["original", "merge_queue", 0],
    ["blocker", "queued", 1],
  ] as const) {
    db.run(
      "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at,session_key) VALUES(?,'epic',?,?,?, ?,?,?,1000,'session')",
      [id, id, id, id, state, `paws/${id}`, position],
    );
    bindWorkItemRepository(db, id, repository);
    saveSchedulingContext(db, { itemId: id, projectId: "project", paths: ["src/shared"] });
  }
  db.run(
    "INSERT INTO task_block(blocker_linear_issue_id,blocked_linear_issue_id) VALUES('blocker','original')",
  );
  ensureLinearSession(db, { sessionId: "session", issueId: "parent", now: clock.now() });
  bindLinearSessionTask(db, "session", "epic");
  activateLinearItem(db, "session", "original");
  const heldLoop = new JobLoop(db, clock);
  let heldTicks = 0;
  registerScheduler(
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
      getLinearSession(db, "session")?.activeItemId === "original" &&
      db.query("SELECT 1 FROM scheduler_admission").get() === null,
    {
      queue: firstTick.queue,
      heldTicks,
      activeItemId: getLinearSession(db, "session")?.activeItemId,
    },
  );
  db.close();
  clock.advance(30000);
  db = openDatabase(databasePath);
  migrate(db);
  const jobs = new JobLoop(db, clock);
  const events: string[] = [];
  const orchestrator = new Orchestrator({
    db,
    jobs,
    clock,
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: root,
    scheduling: () => ({}),
  });
  try {
    registerScheduler(
      jobs,
      () => {
        events.push(`reconcile:${getLinearSession(db, "session")?.activeItemId}`);
        orchestrator.reconcileExecution();
      },
      clock.now(),
    );
    const tick = await jobs.tick();
    const admission = db
      .query<{ item_id: string }, []>("SELECT item_id FROM scheduler_admission")
      .get();
    observe(
      "after restart the same recurring tick yields the merge session and admits the blocker in one dispatch",
      tick?.id === firstTick.id &&
        getJob(db, firstTick.id)?.fireCount === 2 &&
        JSON.stringify(events) === JSON.stringify(["reconcile:original"]) &&
        admission?.item_id === "blocker" &&
        getLinearSession(db, "session")?.activeItemId === null,
      { tick: tick?.id, fireCount: getJob(db, firstTick.id)?.fireCount, events, admission },
    );
    jobs.register(JOB_KIND.start, (job) => {
      const itemId = (job.payload as { itemId: string }).itemId;
      activateLinearItem(db, "session", itemId);
      applyWorkItemEvent(db, itemId, "dispatched");
    });
    const start = await jobs.tick();
    observe(
      "the admitted blocker claims and activates the yielded canonical session",
      start?.queue === JOB_KIND.start &&
        getWorkItem(db, "blocker")?.state === "running" &&
        getLinearSession(db, "session")?.activeItemId === "blocker" &&
        getWorkItem(db, "original")?.state === "merge_queue",
      {
        queue: start?.queue,
        state: getWorkItem(db, "blocker")?.state,
        activeItemId: getLinearSession(db, "session")?.activeItemId,
      },
    );
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
  const defaults = openDatabase(join(root, "default.sqlite"));
  migrate(defaults);
  try {
    insertQueuedItem(defaults, { id: "default", now: clock.now() });
    bindWorkItemRepository(defaults, "default", repository);
    saveSchedulingContext(defaults, {
      itemId: "default",
      projectId: "project",
      paths: ["src/default"],
    });
    const loop = new JobLoop(defaults, clock);
    const run = () => dispatch(defaults, { now: clock.now() });
    registerScheduler(loop, () => void run(), clock.now());
    const tick = await loop.tick();
    const count = defaults
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM scheduler_admission")
      .get()!.count;
    observe(
      "without a custom hook the durable tick and returned dispatcher retain default behavior",
      tick?.queue === "scheduler.tick" && count === 1 && run().length === 0,
      { queue: tick?.queue, admissions: count },
    );
  } finally {
    defaults.close();
  }
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
