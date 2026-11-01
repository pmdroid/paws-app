import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { FakeClock, JOB_KIND, type Checkpoint, type Clock } from "../src/core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  claimNextJob,
  completeJob,
  deferWorkItem,
  enqueueJob,
  getRun,
  getRunnerSetupHold,
  getWorkItem,
  holdForRunnerSetup,
  insertQueuedItem,
  jobVersionCurrent,
  listJobs,
  listOutbox,
  migrate,
  openDatabase,
  prepareShutdown,
  recoverOnStartup,
  type Job,
} from "../src/db";
import { HostSupervisor, WakeDetector } from "../src/host";
import { dispatch } from "../src/scheduler";

const TWO_HOURS = 2 * 60 * 60_000;
const GAPS = [
  ["below two hours", 5 * 60_000],
  ["at two hours", TWO_HOURS],
  ["above two hours", TWO_HOURS + 1],
] as const;
const BACKOFF_MS = 10 * 60_000;
const SLOT_POLL_MS = 30_000;
const EXECUTION: readonly string[] = [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify];
const checkpoint: Checkpoint = { phase: "running", wipCommit: "wip", turn: 2, baseSha: "base" };

const WAITS = ["first-start capacity wait", "resume capacity wait", "transient backoff"] as const;
type Wait = (typeof WAITS)[number];

function boot(clock: Clock & { now(): number } = new FakeClock(1_000_000)) {
  const db = openDatabase(":memory:");
  migrate(db);
  const host = new HostSupervisor(db, clock, new WakeDetector(clock), 250);
  return { db, host };
}

function park(db: Database, now: number, wait: Wait, withCheckpoint: boolean): number {
  insertQueuedItem(db, { id: "eng-9", sessionKey: "linear-session", now });
  const saved = withCheckpoint ? checkpoint : undefined;
  const { item } = beginImplementRun(db, "eng-9", now, saved);
  if (wait === "transient backoff") {
    deferWorkItem(db, item, {
      retry: 2,
      delayMs: BACKOFF_MS,
      handoff: "keep going",
      message: null,
      now,
    });
  } else {
    if (wait === "resume capacity wait") applyWorkItemEvent(db, "eng-9", "lease_expired");
    enqueueJob(db, {
      queue: wait === "first-start capacity wait" ? JOB_KIND.start : JOB_KIND.resume,
      runAt: now + SLOT_POLL_MS,
      payload: {
        itemId: "eng-9",
        capacityWait: { since: now, attempt: 3, runnerIds: ["busy"] },
      },
      now,
    });
  }
  const [job] = executions(db);
  return job!.id;
}

function executions(db: Database, itemId = "eng-9"): Job[] {
  return listJobs(db).filter(
    (job) =>
      EXECUTION.includes(job.queue) &&
      (job.status === "pending" || job.status === "running") &&
      (job.payload as { itemId?: string }).itemId === itemId,
  );
}

function snapshot(db: Database, itemId = "eng-9") {
  const item = getWorkItem(db, itemId)!;
  return {
    item: {
      state: item.state,
      version: item.version,
      currentRunId: item.currentRunId,
      checkpoint: item.checkpoint,
      recoveryAttempts: item.recoveryAttempts,
      resumedAt: item.resumedAt,
      awakeMs: item.awakeMs,
      agentMs: item.agentMs,
      cancelRequested: item.cancelRequested,
    },
    run: item.currentRunId === null ? null : getRun(db, item.currentRunId)?.status,
    jobs: executions(db, itemId).map(
      ({ id, queue, status, runAt, attempts, maxAttempts, payload }) => ({
        id,
        queue,
        status,
        runAt,
        attempts,
        maxAttempts,
        payload,
      }),
    ),
  };
}

function activities(db: Database) {
  return listOutbox(db).filter((message) => message.op === "activity");
}

function observe(db: Database, host: HostSupervisor, now: number): void {
  host.tick();
  host.tick();
  expect(dispatch(db, { now })).toEqual([]);
  dispatch(db, { now });
}

describe("a clock gap during a parked wait", () => {
  for (const wait of WAITS)
    for (const withCheckpoint of [true, false])
      for (const [gapName, gapMs] of GAPS)
        test(`a ${wait} ${withCheckpoint ? "with" : "without"} a checkpoint keeps one owner across a gap ${gapName}`, () => {
          const clock = new FakeClock(1_000_000);
          const { db, host } = boot(clock);
          try {
            const owner = park(db, clock.now(), wait, withCheckpoint);
            host.tick();
            const before = snapshot(db);

            clock.sleep(gapMs);
            observe(db, host, clock.now());

            expect(db.query("SELECT slept_ms FROM wake").all()).toEqual([{ slept_ms: gapMs }]);
            expect(snapshot(db)).toEqual(before);
            expect(activities(db)).toEqual([]);

            const due = before.jobs[0]!.runAt;
            if (due > clock.now()) {
              expect(claimNextJob(db, { now: clock.now(), queues: [...EXECUTION] })).toBeNull();
              clock.advance(due - clock.now());
              observe(db, host, clock.now());
            }
            const claimed = claimNextJob(db, { now: clock.now(), queues: [...EXECUTION] });
            expect(claimed?.id).toBe(owner);
            expect(jobVersionCurrent(db, claimed!)).toBe(true);
            expect(claimNextJob(db, { now: clock.now(), queues: [...EXECUTION] })).toBeNull();
            expect(dispatch(db, { now: clock.now() })).toEqual([]);
            expect(executions(db).map((job) => job.id)).toEqual([owner]);
            expect(completeJob(db, claimed!, clock.now())).toBe(true);
          } finally {
            host.stop();
            db.close();
          }
        });

  for (const wait of WAITS)
    for (const withCheckpoint of [true, false])
      test(`a process restart after a gap above two hours leaves a ${wait} ${withCheckpoint ? "with" : "without"} a checkpoint to its job`, () => {
        const clock = new FakeClock(1_000_000);
        const { db, host } = boot(clock);
        try {
          const owner = park(db, clock.now(), wait, withCheckpoint);
          host.tick();
          const before = snapshot(db);

          prepareShutdown(db, clock.now());
          host.stop();
          clock.sleep(TWO_HOURS + 1);
          clock.advance(1_000);
          expect(recoverOnStartup(db, clock.now())).toEqual([]);
          const next = new HostSupervisor(db, clock, new WakeDetector(clock), 250);
          observe(db, next, clock.now());
          next.stop();

          expect(db.query("SELECT 1 FROM wake").all()).toEqual([]);
          expect(snapshot(db)).toEqual(before);
          expect(claimNextJob(db, { now: clock.now(), queues: [...EXECUTION] })?.id).toBe(owner);
          expect(claimNextJob(db, { now: clock.now(), queues: [...EXECUTION] })).toBeNull();
        } finally {
          db.close();
        }
      });

  for (const wait of WAITS)
    test(`a wall-clock correction forward and back leaves a ${wait} to its job`, () => {
      const wall = { now: 1_000_000, mono: 1_000_000 };
      const clock: Clock = { now: () => wall.now, mono: () => wall.mono };
      const { db, host } = boot(clock);
      try {
        const owner = park(db, wall.now, wait, false);
        host.tick();
        const before = snapshot(db);

        wall.now += 3 * 60 * 60_000 + 1_000;
        wall.mono += 1_000;
        observe(db, host, wall.now);
        expect(snapshot(db)).toEqual(before);

        wall.now -= 3 * 60 * 60_000;
        wall.mono += 1_000;
        observe(db, host, wall.now);
        expect(snapshot(db)).toEqual(before);
        expect(db.query("SELECT slept_ms FROM wake").all()).toEqual([
          { slept_ms: 3 * 60 * 60_000 },
        ]);
        const due = before.jobs[0]!.runAt;
        expect(claimNextJob(db, { now: due - 1, queues: [...EXECUTION] })).toBeNull();
        expect(claimNextJob(db, { now: due, queues: [...EXECUTION] })?.id).toBe(owner);
        expect(claimNextJob(db, { now: due, queues: [...EXECUTION] })).toBeNull();
        expect(activities(db)).toEqual([]);
      } finally {
        host.stop();
        db.close();
      }
    });
});

describe("ownership a clock gap does not invent", () => {
  function abandoned(how: "stale version" | "cancelled" | "another item's job") {
    const clock = new FakeClock(1_000_000);
    const { db, host } = boot(clock);
    const owner = park(db, clock.now(), "transient backoff", false);
    if (how === "stale version") db.run("UPDATE work_item SET version=version+1 WHERE id='eng-9'");
    if (how === "cancelled")
      db.run("UPDATE job SET status='cancelled', finished_at=? WHERE id=?", [clock.now(), owner]);
    if (how === "another item's job") {
      insertQueuedItem(db, { id: "eng-10", now: clock.now() });
      db.run("UPDATE job SET payload=json_set(payload,'$.itemId','eng-10') WHERE id=?", [owner]);
    }
    host.tick();
    clock.sleep(TWO_HOURS + 1);
    host.tick();
    return { clock, db, host, owner };
  }

  for (const how of ["stale version", "cancelled", "another item's job"] as const) {
    test(`a ${how} transient retry does not stop startup from resuming abandoned work once`, () => {
      const { clock, db, host, owner } = abandoned(how);
      try {
        expect(recoverOnStartup(db, clock.now())).toEqual([
          { type: "resume", freshSession: true, checkpoint: null },
        ]);
        const resumes = executions(db).filter((job) => job.id !== owner);
        expect(resumes).toHaveLength(1);
        expect(jobVersionCurrent(db, resumes[0]!)).toBe(true);
        expect(getWorkItem(db, "eng-9")).toMatchObject({
          state: "recovering",
          recoveryAttempts: 1,
        });
        expect(recoverOnStartup(db, clock.now())).toEqual([{ type: "ask_restart" }]);
      } finally {
        host.stop();
        db.close();
      }
    });

    test(`a ${how} transient retry does not keep the orphan sweep from picking the work up`, () => {
      const { clock, db, host, owner } = abandoned(how);
      try {
        enqueueJob(db, { queue: JOB_KIND.command, payload: { itemId: "eng-9" }, now: 0 });
        db.run("UPDATE job SET status='done', finished_at=0 WHERE queue=?", [JOB_KIND.command]);
        expect(dispatch(db, { now: clock.now() })).toEqual([]);
        dispatch(db, { now: clock.now() });
        const resumes = executions(db).filter((job) => job.id !== owner);
        expect(resumes).toMatchObject([
          { queue: JOB_KIND.resume, payload: { reason: "orphaned" } },
        ]);
        expect(jobVersionCurrent(db, resumes[0]!)).toBe(true);
      } finally {
        host.stop();
        db.close();
      }
    });
  }

  test("a capacity wait parked at an older item version is not a parked wait at startup", () => {
    const clock = new FakeClock(1_000_000);
    const { db, host } = boot(clock);
    try {
      park(db, clock.now(), "first-start capacity wait", true);
      db.run("UPDATE work_item SET version=version+1 WHERE id='eng-9'");
      clock.sleep(TWO_HOURS + 1);
      expect(recoverOnStartup(db, clock.now())).toEqual([
        { type: "resume", freshSession: true, checkpoint },
      ]);
    } finally {
      host.stop();
      db.close();
    }
  });
});

describe("repeated clock gaps with holds and parked waits side by side", () => {
  test("holds stay held and waits keep one owner, budget and question across three gaps", () => {
    const clock = new FakeClock(1_000_000);
    const { db, host } = boot(clock);
    try {
      park(db, clock.now(), "transient backoff", true);
      insertQueuedItem(db, { id: "eng-10", sessionKey: "session-10", now: clock.now() });
      beginImplementRun(db, "eng-10", clock.now());
      enqueueJob(db, {
        queue: JOB_KIND.start,
        runAt: clock.now() + SLOT_POLL_MS,
        payload: {
          itemId: "eng-10",
          capacityWait: { since: clock.now(), attempt: 0, runnerIds: ["busy"] },
        },
        now: clock.now(),
      });
      insertQueuedItem(db, { id: "eng-11", sessionKey: "session-11", now: clock.now() });
      holdForRunnerSetup(db, {
        itemId: "eng-11",
        ownerUserId: null,
        reason: "no-runner",
        now: clock.now(),
      });
      insertQueuedItem(db, { id: "eng-12", sessionKey: "session-12", now: clock.now() });
      beginImplementRun(db, "eng-12", clock.now(), checkpoint);
      applyWorkItemEvent(db, "eng-12", "blocking_question");
      db.run("UPDATE work_item SET recovery_attempts=1 WHERE id IN ('eng-9','eng-10')");

      host.tick();
      const ids = ["eng-9", "eng-10", "eng-11", "eng-12"];
      const before = ids.map((id) => snapshot(db, id));
      const hold = getRunnerSetupHold(db, "eng-11");
      const outbox = listOutbox(db).length;

      for (const gapMs of [5 * 60_000, TWO_HOURS, TWO_HOURS + 1]) {
        clock.sleep(gapMs);
        observe(db, host, clock.now());
        clock.advance(250);
        host.tick();
      }

      expect(ids.map((id) => snapshot(db, id))).toEqual(before);
      expect(getRunnerSetupHold(db, "eng-11")).toEqual(hold);
      expect(getWorkItem(db, "eng-12")?.state).toBe("awaiting_input");
      expect(listOutbox(db)).toHaveLength(outbox);
      expect(db.query("SELECT COUNT(*) AS n FROM wake").get()).toEqual({ n: 3 });
      expect(listJobs(db).filter((job) => job.queue === JOB_KIND.catchup)).toHaveLength(3);
      expect(executions(db, "eng-11")).toEqual([]);
      expect(executions(db, "eng-12")).toEqual([]);
      const claimed: string[] = [];
      for (let job = claimNextJob(db, { now: clock.now(), queues: [...EXECUTION] }); job;) {
        claimed.push((job.payload as { itemId: string }).itemId);
        job = claimNextJob(db, { now: clock.now(), queues: [...EXECUTION] });
      }
      expect(claimed.sort()).toEqual(["eng-10", "eng-9"]);
    } finally {
      host.stop();
      db.close();
    }
  });
});
