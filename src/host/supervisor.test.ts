import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_AWAKE_MS,
  DEFAULT_MAX_TURNS,
  FakeClock,
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
  listJobs,
  listOutbox,
  migrate,
  openDatabase,
  prepareShutdown,
} from "../db";
import type { Spawn } from "./keep-awake";
import { KeepAwake } from "./keep-awake";
import { HostSupervisor } from "./supervisor";
import { WakeDetector } from "./wake";

const checkpoint: Checkpoint = { phase: "running", wipCommit: "wip", turn: 3, baseSha: "main" };

function recorder(): {
  spawn: Spawn;
  calls: { command: string; args: string[] }[];
  kills: () => number;
} {
  const calls: { command: string; args: string[] }[] = [];
  let killed = 0;
  const spawn: Spawn = (command, args) => {
    calls.push({ command, args });
    return {
      kill() {
        killed += 1;
      },
    };
  };
  return { spawn, calls, kills: () => killed };
}

function boot(
  agentAlive: (runId: string) => boolean = () => true,
  platform = "linux",
  restartFromMain?: (item: { id: string; branchName: string }) => void,
) {
  const clock = new FakeClock(1_000_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const recorded = recorder();
  const host = new HostSupervisor(
    db,
    clock,
    new KeepAwake(platform, 99, recorded.spawn),
    new WakeDetector(clock),
    agentAlive,
    250,
    restartFromMain,
  );
  return { clock, db, recorded, host };
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

function activities(db: ReturnType<typeof boot>["db"]) {
  return listOutbox(db).filter((message) => message.op === "activity");
}

describe("laptop sleep and wake", () => {
  test("a short sleep with a live agent posts one resuming note and keeps the run", () => {
    const { clock, db, recorded, host } = boot(() => true);
    const { run } = startRun(db, clock);
    host.tick();
    expect(recorded.calls[0]?.command).toBe("systemd-inhibit");
    expect(recorded.calls[0]?.args).toContain("--what=idle:sleep");

    clock.sleep(5 * 60_000);
    host.tick();

    expect(getWorkItem(db, "eng-9")).toMatchObject({ state: "running", branchName: "paws/eng-9" });
    expect(getRun(db, run.id)?.status).toBe("active");
    expect(activities(db).map((message) => message.payload)).toEqual([
      { text: "Paused for 5 min (laptop asleep), resuming." },
    ]);
    expect(listJobs(db).filter((job) => job.queue === "linear.catchup")).toHaveLength(1);
    expect(recorded.kills()).toBe(0);

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
      text: "Paused for 5 min (laptop asleep), resuming.",
    });
  });

  test("sleep longer than two hours restarts the item from fresh main and keeps the WIP branch", () => {
    const { clock, db, recorded, host } = boot(() => true);
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
      text: "Paused for 120 min (laptop asleep). Restarting from fresh main.",
    });
    expect(recorded.kills()).toBe(1);
  });

  test("exactly two hours resumes instead of starting over", () => {
    const checkouts: string[] = [];
    const { clock, db, host } = boot(
      () => true,
      "linux",
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
      text: "Paused for 120 min (laptop asleep), resuming.",
    });
  });

  test("sleep longer than two hours checks out fresh main and keeps the WIP branch", () => {
    const checkouts: { id: string; branchName: string }[] = [];
    const { clock, db, host } = boot(
      () => true,
      "linux",
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
      lane: "merge",
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
      text: "Paused for 5 min (laptop asleep), resuming.",
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

  test("parked time is not awake time and drops the keep-awake assertion", () => {
    const { clock, db, recorded, host } = boot();
    startRun(db, clock);
    host.tick();
    applyWorkItemEvent(db, "eng-9", "blocking_question");
    clock.advance(10_000);
    host.tick();
    expect(recorded.kills()).toBe(1);
    applyWorkItemEvent(db, "eng-9", "answer_received");
    clock.advance(100);
    host.tick();
    expect(getWorkItem(db, "eng-9")?.awakeMs).toBe(100);
    expect(recorded.calls).toHaveLength(2);
  });

  test("a parked question stays parked and still gets one pause note", () => {
    const { clock, db, host } = boot(() => false);
    startRun(db, clock);
    applyWorkItemEvent(db, "eng-9", "blocking_question");
    host.tick();
    clock.sleep(5 * 60_000);
    host.tick();
    expect(getWorkItem(db, "eng-9")?.state).toBe("awaiting_input");
    expect(activities(db).map((message) => message.payload)).toEqual([
      { text: "Paused for 5 min (laptop asleep), resuming." },
    ]);
  });

  test("a wake with nothing in flight still enqueues catch-up and no pause note", () => {
    const { clock, db, host } = boot();
    host.tick();
    clock.sleep(5 * 60_000);
    host.tick();
    expect(activities(db)).toHaveLength(0);
    expect(listJobs(db).filter((job) => job.queue === "linear.catchup")).toHaveLength(1);
  });

  test("macOS keep-awake uses caffeinate against this process pid", () => {
    const { db, recorded, host } = boot(() => true, "darwin");
    const clock = new FakeClock(1_000_000);
    insertQueuedItem(db, { id: "eng-9", now: clock.now() });
    beginImplementRun(db, "eng-9", clock.now(), checkpoint);
    host.tick();
    expect(recorded.calls).toEqual([{ command: "caffeinate", args: ["-i", "-w", "99"] }]);
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

  test("stop releases keep-awake and leaves the item resumable", () => {
    const { db, clock, recorded, host } = boot();
    startRun(db, clock);
    host.tick();
    host.stop();
    prepareShutdown(db, clock.now());
    expect(recorded.kills()).toEqual(1);
    expect(getWorkItem(db, "eng-9")?.state).toBe("recovering");
    host.tick();
    expect(recorded.kills()).toEqual(1);
  });
});
