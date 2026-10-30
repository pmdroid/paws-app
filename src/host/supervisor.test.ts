import { describe, expect, spyOn, test } from "bun:test";
import {
  DEFAULT_MAX_AWAKE_MS,
  DEFAULT_MAX_TURNS,
  FakeClock,
  JOB_KIND,
  LONG_SLEEP_MS,
  type Checkpoint,
} from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  claimNextJob,
  completeJob,
  enqueueJob,
  enterMergeQueue,
  getRun,
  getWorkItem,
  insertQueuedItem,
  JobLoop,
  listJobs,
  listOutbox,
  markCloseoutAccepted,
  migrate,
  openDatabase,
  prepareShutdown,
  recordTurn,
} from "../db";
import { startHost } from "./index";
import { HostSupervisor } from "./supervisor";
import { WakeDetector } from "./wake";

const checkpoint: Checkpoint = { phase: "running", wipCommit: "wip", turn: 3, baseSha: "main" };

function boot(
  agentAlive: (runId: string) => boolean = () => true,
  restartFromMain?: (item: { id: string; branchName: string }) => void,
) {
  const clock = new FakeClock(1_000_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const host = new HostSupervisor(
    db,
    clock,
    new WakeDetector(clock),
    agentAlive,
    250,
    restartFromMain,
  );
  return { clock, db, host };
}

function startRun(
  db: ReturnType<typeof boot>["db"],
  clock: FakeClock,
  overrides: { maxAwakeMs?: number; maxTurns?: number } = {},
) {
  insertQueuedItem(db, {
    id: "eng-9",
    sessionKey: "linear-session",
    branchName: "paws/eng-9",
    maxAwakeMs: overrides.maxAwakeMs ?? DEFAULT_MAX_AWAKE_MS,
    maxTurns: overrides.maxTurns ?? DEFAULT_MAX_TURNS,
    now: clock.now(),
  });
  return beginImplementRun(db, "eng-9", clock.now(), checkpoint);
}

/** A job that holds the item's lease, as one does while Closeout verifies it. */
function verifyingJob(db: ReturnType<typeof boot>["db"], clock: FakeClock) {
  enqueueJob(db, { queue: JOB_KIND.reverify, payload: { itemId: "eng-9" }, now: clock.now() });
  return claimNextJob(db, {
    now: clock.now(),
    leaseMs: 24 * 60 * 60_000,
    queues: [JOB_KIND.reverify],
  })!;
}

function activities(db: ReturnType<typeof boot>["db"]) {
  return listOutbox(db).filter((message) => message.op === "activity");
}

describe("supervisor accrual writes", () => {
  test("hours in the merge queue do not count as agent time after a review restart", () => {
    const { clock, db, host } = boot();
    try {
      startRun(db, clock);
      host.tick();
      clock.advance(10 * 60_000);
      host.tick();
      applyWorkItemEvent(db, "eng-9", "turn_ended");
      applyWorkItemEvent(db, "eng-9", "closeout_accepted");
      markCloseoutAccepted(db, "eng-9", "accepted");
      for (let hour = 0; hour < 4; hour += 1) {
        clock.advance(60 * 60_000);
        host.tick();
      }
      // A changes-requested review sends the item back; it waits a tick for a runner.
      applyWorkItemEvent(db, "eng-9", "restart", { kind: "restart", reason: "review" });
      host.tick();
      applyWorkItemEvent(db, "eng-9", "dispatched");
      host.tick();
      clock.advance(5 * 60_000);
      host.tick();

      expect(getWorkItem(db, "eng-9")).toMatchObject({
        state: "running",
        agentMs: 15 * 60_000,
        awakeMs: 15 * 60_000,
      });
    } finally {
      host.stop();
    }
  });

  test("only changed awake items are written once per tick", () => {
    const { clock, db, host } = boot();
    try {
      for (const id of ["awake", "paused", "idle"]) {
        insertQueuedItem(db, { id, now: clock.now() });
        if (id !== "idle") beginImplementRun(db, id, clock.now());
      }
      applyWorkItemEvent(db, "paused", "pause");
      db.exec(`
        CREATE TEMP TABLE item_write (id TEXT);
        CREATE TEMP TRIGGER count_item_write AFTER UPDATE ON work_item BEGIN
          INSERT INTO item_write VALUES (NEW.id);
        END;
      `);
      const writes = () => db.query<{ id: string }, []>("SELECT id FROM item_write").all();

      host.tick();
      host.tick();
      expect(writes()).toEqual([]);
      clock.advance(250);
      host.tick();
      expect(writes()).toEqual([{ id: "awake" }]);
      expect(getWorkItem(db, "awake")).toMatchObject({ awakeMs: 250, agentMs: 250 });
      expect(getWorkItem(db, "paused")).toMatchObject({ awakeMs: 0, lastMonoMs: null });
      expect(getWorkItem(db, "idle")).toMatchObject({ awakeMs: 0, lastMonoMs: null });
      host.tick();
      clock.sleep(1_000);
      host.tick();
      expect(writes()).toEqual([{ id: "awake" }]);
      clock.advance(250);
      host.tick();
      expect(writes()).toEqual([{ id: "awake" }, { id: "awake" }]);

      applyWorkItemEvent(db, "paused", "resume");
      db.exec("DELETE FROM item_write");
      clock.advance(250);
      host.tick();
      expect(writes()).toEqual([{ id: "awake" }, { id: "paused" }]);
      expect(getWorkItem(db, "paused")).toMatchObject({ awakeMs: 250, agentMs: 250 });
    } finally {
      host.stop();
      db.close();
    }
  });

  test("all item writes in a tick commit or roll back together", () => {
    const { clock, db, host } = boot();
    try {
      for (const id of ["first", "second"]) {
        insertQueuedItem(db, { id, now: clock.now() });
        beginImplementRun(db, id, clock.now());
      }
      host.tick();
      clock.advance(250);
      db.exec(`
        CREATE TEMP TRIGGER reject_second BEFORE UPDATE ON work_item
        WHEN NEW.id = 'second' BEGIN SELECT RAISE(ABORT, 'tick failed'); END;
      `);
      expect(() => host.tick()).toThrow("tick failed");
      expect(getWorkItem(db, "first")).toMatchObject({ awakeMs: 0, agentMs: 0, lastMonoMs: null });
      expect(getWorkItem(db, "second")).toMatchObject({ awakeMs: 0, agentMs: 0, lastMonoMs: null });
      db.exec("DROP TRIGGER reject_second");
      host.tick();
      expect(getWorkItem(db, "first")).toMatchObject({ awakeMs: 250, agentMs: 250 });
      expect(getWorkItem(db, "second")).toMatchObject({ awakeMs: 250, agentMs: 250 });
    } finally {
      host.stop();
      db.close();
    }
  });
});

describe("laptop sleep and wake", () => {
  test("an active run does not acquire a system sleep inhibitor", () => {
    const db = openDatabase(":memory:");
    migrate(db);
    const clock = new FakeClock(1_000_000);
    startRun(db, clock);
    const spawn = spyOn(Bun, "spawn").mockImplementation(() => {
      throw new Error("The host must not spawn a sleep inhibitor");
    });
    const controller = new AbortController();
    const host = startHost({ db, clock, signal: controller.signal });
    try {
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      host.stop();
      controller.abort();
      spawn.mockRestore();
      db.close();
    }
  });
  test("a short sleep with a live agent posts one resuming note and keeps the run", () => {
    const { clock, db, host } = boot(() => true);
    const { run } = startRun(db, clock);
    host.tick();

    clock.sleep(5 * 60_000);
    host.tick();

    expect(getWorkItem(db, "eng-9")).toMatchObject({ state: "running", branchName: "paws/eng-9" });
    expect(getRun(db, run.id)?.status).toBe("active");
    expect(activities(db).map((message) => message.payload)).toEqual([
      {
        sessionId: "linear-session",
        kind: "thought",
        body: "Paused for 5 min (laptop asleep), resuming.",
      },
    ]);
    expect(listJobs(db).filter((job) => job.queue === "linear.catchup")).toHaveLength(1);

    host.tick();
    expect(activities(db)).toHaveLength(1);
    expect(listJobs(db).filter((job) => job.queue === "linear.catchup")).toHaveLength(1);
  });

  test("a dead agent restarts from the checkpoint with a fresh session", () => {
    const { clock, db, host } = boot(() => false);
    const { run } = startRun(db, clock);
    host.tick();
    clock.sleep(5 * 60_000);
    host.tick();

    const item = getWorkItem(db, "eng-9");
    expect(item?.state).toBe("running");
    expect(getRun(db, run.id)?.status).toBe("lost");
    expect(item?.currentRunId).not.toBe(run.id);
    const next =
      item?.currentRunId === null || item === null ? null : getRun(db, item.currentRunId);
    expect(next?.freshSession).toBe(true);
    const resume = listJobs(db).find((job) => job.queue === "run.resume");
    expect(resume?.payload).toMatchObject({ freshSession: true, checkpoint });
    expect(activities(db)[0]?.payload).toEqual({
      sessionId: "linear-session",
      kind: "thought",
      body: "Paused for 5 min (laptop asleep), resuming.",
    });
  });

  test("sleep longer than two hours restarts the item from fresh main and keeps the WIP branch", () => {
    const { clock, db, host } = boot(() => true);
    const { run } = startRun(db, clock);
    host.tick();
    clock.sleep(LONG_SLEEP_MS + 1);
    host.tick();

    expect(getWorkItem(db, "eng-9")).toMatchObject({
      state: "queued",
      branchName: "paws/eng-9",
      checkpoint: null,
      turnCount: 0,
      awakeMs: 0,
    });
    expect(getRun(db, run.id)?.status).toBe("lost");
    const start = listJobs(db).find((job) => job.queue === "item.start");
    expect(start?.payload).toMatchObject({ from: "fresh_main", wipBranch: "paws/eng-9" });
    expect(activities(db)[0]?.payload).toEqual({
      sessionId: "linear-session",
      kind: "thought",
      body: "Paused for 120 min (laptop asleep). Restarting from fresh main.",
    });
  });

  test("exactly two hours resumes instead of starting over", () => {
    const checkouts: string[] = [];
    const { clock, db, host } = boot(
      () => true,
      (item) => {
        checkouts.push(item.branchName);
      },
    );
    startRun(db, clock);
    host.tick();
    clock.sleep(LONG_SLEEP_MS);
    host.tick();
    expect(getWorkItem(db, "eng-9")?.state).toBe("running");
    expect(checkouts).toEqual([]);
    expect(activities(db)[0]?.payload).toEqual({
      sessionId: "linear-session",
      kind: "thought",
      body: "Paused for 120 min (laptop asleep), resuming.",
    });
  });

  test("sleep longer than two hours checks out fresh main and keeps the WIP branch", () => {
    const checkouts: { id: string; branchName: string }[] = [];
    const { clock, db, host } = boot(
      () => true,
      (item) => {
        checkouts.push({ id: item.id, branchName: item.branchName });
      },
    );
    startRun(db, clock);
    host.tick();
    clock.sleep(LONG_SLEEP_MS + 1);
    host.tick();

    expect(checkouts).toEqual([{ id: "eng-9", branchName: "paws/eng-9" }]);
    expect(getWorkItem(db, "eng-9")).toMatchObject({
      state: "queued",
      branchName: "paws/eng-9",
    });
    const start = listJobs(db).find((job) => job.queue === "item.start");
    expect(start?.payload).toMatchObject({ from: "fresh_main", wipBranch: "paws/eng-9" });
    host.tick();
    expect(checkouts).toHaveLength(1);
  });

  test("a merge fails closed across a short sleep and cannot be completed", () => {
    const { clock, db, host } = boot(() => true);
    startRun(db, clock);
    enterMergeQueue(db, "eng-9", checkpoint);
    enqueueJob(db, {
      queue: "github.merge",
      payload: { itemId: "eng-9" },
      now: clock.now(),
    });
    const claimed = claimNextJob(db, {
      workerId: "merger",
      now: clock.now(),
      queues: ["github.merge"],
    });
    expect(claimed).not.toBeNull();

    host.tick();
    clock.sleep(5 * 60_000);
    host.tick();

    expect(getWorkItem(db, "eng-9")?.state).toBe("verifying");
    expect(claimed !== null && completeJob(db, claimed, clock.now())).toBe(false);
    expect(
      listJobs(db).some((job) => job.queue === "run.reverify" && job.status === "pending"),
    ).toBe(true);
    expect(activities(db)[0]?.payload).toEqual({
      sessionId: "linear-session",
      kind: "thought",
      body: "Paused for 5 min (laptop asleep), resuming.",
    });
  });

  test("a merge that slept more than two hours starts over from main", () => {
    const { clock, db, host } = boot(() => true);
    startRun(db, clock);
    enterMergeQueue(db, "eng-9", checkpoint);
    host.tick();
    clock.sleep(LONG_SLEEP_MS + 1);
    host.tick();
    expect(getWorkItem(db, "eng-9")?.state).toBe("queued");
    expect(getWorkItem(db, "eng-9")?.branchName).toBe("paws/eng-9");
  });

  test("awake time does not include the sleep, and the cap still trips on awake time", () => {
    const { clock, db, host } = boot();
    startRun(db, clock, { maxAwakeMs: 1_000 });
    host.tick();
    clock.sleep(30 * 60_000);
    clock.advance(10);
    host.tick();
    expect(getWorkItem(db, "eng-9")).toMatchObject({ state: "running", awakeMs: 10 });

    clock.advance(990);
    host.tick();
    expect(getWorkItem(db, "eng-9")?.state).toBe("failed");
  });

  test("the default budget allows a 45-minute task and stops at three hours", () => {
    const { clock, db, host } = boot();
    try {
      startRun(db, clock);
      host.tick();
      clock.advance(45 * 60_000);
      host.tick();
      expect(getWorkItem(db, "eng-9")?.state).toBe("running");
      applyWorkItemEvent(db, "eng-9", "turn_ended");
      verifyingJob(db, clock);
      clock.advance(135 * 60_000 - 1);
      host.tick();
      expect(getWorkItem(db, "eng-9")?.state).toBe("verifying");
      clock.advance(1);
      host.tick();
      expect(getWorkItem(db, "eng-9")?.state).toBe("failed");
      expect(activities(db).at(-1)?.payload).toMatchObject({
        kind: "error",
        body: "Run hit the awake time cap (180 min). Counted: agent turns 45 min, Closeout 2 h 15 min.",
      });
    } finally {
      host.stop();
      db.close();
    }
  });

  test("verifying with no job working on it is not Closeout time", async () => {
    const { clock, db, host } = boot();
    const jobs = new JobLoop(db, clock, { leaseMs: 24 * 60 * 60_000 });
    let finish = () => {};
    jobs.register(
      JOB_KIND.reverify,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const verify = () => {
      enqueueJob(db, { queue: JOB_KIND.reverify, payload: { itemId: "eng-9" }, now: clock.now() });
      return jobs.tick([JOB_KIND.reverify]);
    };
    try {
      startRun(db, clock);
      host.tick();
      clock.advance(40 * 60_000);
      host.tick();
      applyWorkItemEvent(db, "eng-9", "turn_ended");
      // Two idle hours pass without a tick, then a job claims the item.
      clock.advance(2 * 60 * 60_000);
      const running = verify();
      clock.advance(20 * 60_000);
      host.tick();
      // The job ends between ticks, and the item sits in verifying for two hours.
      clock.advance(5 * 60_000);
      finish();
      await running;
      clock.advance(2 * 60 * 60_000);
      host.tick();
      expect(getWorkItem(db, "eng-9")).toMatchObject({
        state: "verifying",
        awakeMs: 65 * 60_000,
        agentMs: 40 * 60_000,
        closeoutMs: 25 * 60_000,
      });
    } finally {
      host.stop();
      db.close();
    }
  });

  test("parked time is not awake time", () => {
    const { clock, db, host } = boot();
    startRun(db, clock);
    host.tick();
    applyWorkItemEvent(db, "eng-9", "blocking_question");
    clock.advance(10_000);
    host.tick();
    applyWorkItemEvent(db, "eng-9", "answer_received");
    clock.advance(100);
    host.tick();
    expect(getWorkItem(db, "eng-9")?.awakeMs).toBe(100);
  });

  test.each(["blocking_question", "pause"] as const)(
    "a %s wait stays parked without reactivating Linear",
    (event) => {
      const { clock, db, host } = boot(() => false);
      startRun(db, clock);
      applyWorkItemEvent(db, "eng-9", event);
      host.tick();
      clock.sleep(5 * 60_000);
      host.tick();
      expect(getWorkItem(db, "eng-9")?.state).toBe(event === "pause" ? "paused" : "awaiting_input");
      expect(activities(db)).toEqual([]);
    },
  );

  test("a wake with nothing in flight still enqueues catch-up and no pause note", () => {
    const { clock, db, host } = boot();
    host.tick();
    clock.sleep(5 * 60_000);
    host.tick();
    expect(activities(db)).toHaveLength(0);
    expect(listJobs(db).filter((job) => job.queue === "linear.catchup")).toHaveLength(1);
  });

  test("SIGTERM commits WIP on the item branch before the run is left recoverable", () => {
    const { db, clock } = boot();
    const { run } = startRun(db, clock);
    const commits: { branchName: string; sha: string }[] = [];
    prepareShutdown(db, clock.now(), (item) => {
      expect(getWorkItem(db, item.id)?.state).toBe("running");
      commits.push({ branchName: item.branchName, sha: "wip-sha" });
    });
    expect(commits).toEqual([{ branchName: "paws/eng-9", sha: "wip-sha" }]);
    expect(getWorkItem(db, "eng-9")?.state).toBe("recovering");
    expect(getRun(db, run.id)?.status).toBe("lost");
  });

  test("stop leaves the item resumable", () => {
    const { db, clock, host } = boot();
    startRun(db, clock);
    host.tick();
    host.stop();
    clock.advance(100);
    host.tick();
    expect(getWorkItem(db, "eng-9")?.awakeMs).toBe(0);
    prepareShutdown(db, clock.now());
    expect(getWorkItem(db, "eng-9")?.state).toBe("recovering");
    host.tick();
  });
});

test("the supervisor stops the live agent when the time limit asks instead of failing", () => {
  const clock = new FakeClock(1_000_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const stopped: string[] = [];
  const host = new HostSupervisor(
    db,
    clock,
    new WakeDetector(clock),
    () => true,
    250,
    undefined,
    undefined,
    (itemId) => stopped.push(itemId),
  );
  insertQueuedItem(db, { id: "eng-9", sessionKey: "linear-session", maxAwakeMs: 1_000, now: 0 });
  const { run } = beginImplementRun(db, "eng-9", clock.now(), checkpoint);
  markCloseoutAccepted(db, "eng-9", "wip");
  host.tick();
  clock.advance(500);
  host.tick();
  expect(stopped).toEqual([]);
  clock.advance(600);
  host.tick();
  expect(stopped).toEqual(["eng-9"]);
  expect(getWorkItem(db, "eng-9")?.state).toBe("running");
  expect(listJobs(db).filter((job) => job.queue === "item.ask")).toHaveLength(1);
  expect(getRun(db, run.id)?.status).toBe("ended");
  host.tick();
  expect(stopped).toEqual(["eng-9"]);
});

test("a turn recorded past the time limit leaves the ask and the stop to the supervisor", () => {
  const clock = new FakeClock(1_000_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const stopped: string[] = [];
  const host = new HostSupervisor(
    db,
    clock,
    new WakeDetector(clock),
    () => true,
    250,
    undefined,
    undefined,
    (itemId) => stopped.push(itemId),
  );
  insertQueuedItem(db, { id: "eng-9", sessionKey: "linear-session", maxAwakeMs: 1_000, now: 0 });
  const { run } = beginImplementRun(db, "eng-9", clock.now(), checkpoint);
  markCloseoutAccepted(db, "eng-9", "wip");
  db.run("UPDATE work_item SET awake_ms = 2000 WHERE id = 'eng-9'");

  const turn = recordTurn(db, "eng-9", clock.now());
  expect(turn).toMatchObject({ capped: false, item: { state: "running" } });
  expect(turn.stopAgent).toBeUndefined();
  expect(getRun(db, run.id)?.status).toBe("active");
  expect(stopped).toEqual([]);

  host.tick();
  expect(stopped).toEqual(["eng-9"]);
  expect(getWorkItem(db, "eng-9")?.state).toBe("running");
  expect(listJobs(db).filter((job) => job.queue === "item.ask")).toHaveLength(1);
  expect(getRun(db, run.id)?.status).toBe("ended");
});
