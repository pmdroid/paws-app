import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { FakeClock, JOB_KIND, type Checkpoint } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyWorkItemEvent,
  beginImplementRun,
  bindWorkItemRepository,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  markCloseoutAccepted,
  recoverOnStartup,
  requeueOrphanedWork,
  saveCheckpoint,
} from "../src/db";
import { HostSupervisor, WakeDetector } from "../src/host";
import { ask, attachOrchestrator, questionEffects } from "../src/loop";
import { answer, findOpenQuestion } from "../src/questions";
import { workspaceAdmission } from "./fake-workspace";
import { tempDb, tempHome } from "./helpers";

const TWO_HOURS = 2 * 60 * 60_000;
const GAPS = [
  ["below two hours", 5 * 60_000],
  ["at two hours", TWO_HOURS],
  ["above two hours", TWO_HOURS + 1],
] as const;
const HOLDS = ["paused", "awaiting_input", "manual"] as const;
type Hold = (typeof HOLDS)[number];

const RUNNING: Checkpoint = { phase: "running", baseSha: "main", wipCommit: "wip", turn: 3 };
const MERGING: Checkpoint = { phase: "merge_queue", baseSha: "main", wipCommit: "wip", turn: 3 };
const EXECUTION: readonly string[] = [JOB_KIND.start, JOB_KIND.resume, JOB_KIND.reverify];

function seed(db: Database, now: number): void {
  insertQueuedItem(db, { id: "item", sessionKey: "session", now });
  bindWorkItemRepository(db, "item", {
    owner: "owner",
    repo: "repo",
    remoteUrl: "https://example.invalid/repo.git",
  });
}

function hold(db: Database, now: number, kind: Hold, merging: boolean): void {
  seed(db, now);
  const { run } = beginImplementRun(db, "item", now, RUNNING);
  if (kind === "paused") applyWorkItemEvent(db, "item", "pause", { now });
  if (kind === "manual") {
    applyWorkItemEvent(db, "item", "run_failed", { now });
    applyWorkItemEvent(db, "item", "take_over", { now });
  }
  if (kind === "awaiting_input") {
    if (merging) {
      applyWorkItemEvent(db, "item", "turn_ended", { now });
      applyWorkItemEvent(db, "item", "closeout_accepted", { now });
      markCloseoutAccepted(db, "item", "wip");
      ask(db, { itemId: "item", runId: null, sessionId: "session" }, "ci-help", "CI failed.", {
        now,
      });
    } else {
      ask(db, { itemId: "item", runId: run.id, sessionId: "session" }, "agent", "Archived?", {
        now,
      });
    }
  }
  if (merging) {
    markCloseoutAccepted(db, "item", "wip");
    saveCheckpoint(db, "item", MERGING);
  }
  expect(getWorkItem(db, "item")?.state).toBe(kind);
}

function executions(db: Database) {
  return listJobs(db).filter(
    (job) =>
      EXECUTION.includes(job.queue) && (job.status === "pending" || job.status === "running"),
  );
}

function actionableQuestions(db: Database) {
  return db
    .query<{ id: string }, []>(
      "SELECT id FROM question WHERE item_id='item' AND cancelled_at IS NULL AND status IN ('open','queued')",
    )
    .all();
}

function snapshot(db: Database) {
  const item = getWorkItem(db, "item")!;
  return {
    item: {
      state: item.state,
      version: item.version,
      checkpoint: item.checkpoint,
      acceptedHead: item.acceptedHead,
      currentRunId: item.currentRunId,
      recoveryAttempts: item.recoveryAttempts,
      cancelRequested: item.cancelRequested,
    },
    run: item.currentRunId ? getRun(db, item.currentRunId)?.status : null,
    jobs: listJobs(db)
      .filter((job) => job.queue !== JOB_KIND.catchup)
      .map((job) => ({ id: job.id, queue: job.queue, status: job.status, runAt: job.runAt })),
    questions: db
      .query("SELECT id, status, cancelled_at FROM question WHERE item_id='item' ORDER BY id")
      .all(),
    activities: listOutbox(db).filter((message) => message.op !== "linear.catchup").length,
  };
}

function orchestrate(db: Database, clock: FakeClock) {
  const jobs = new JobLoop(db, clock);
  attachOrchestrator({
    db,
    jobs,
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: tempHome(),
    admission: workspaceAdmission(db),
    clock,
  });
  return jobs;
}

async function observeGaps(db: Database, clock: FakeClock, gapMs: number): Promise<void> {
  const host = new HostSupervisor(db, clock, new WakeDetector(clock), 250);
  const jobs = orchestrate(db, clock);
  const since = clock.now();
  try {
    host.tick();
    for (let gap = 0; gap < 3; gap += 1) {
      clock.sleep(gapMs);
      host.tick();
      clock.advance(250);
      host.tick();
      await jobs.tick([JOB_KIND.catchup]);
    }
  } finally {
    host.stop();
  }
  expect(db.query("SELECT slept_ms FROM wake WHERE from_wall >= ?").all(since)).toEqual([
    { slept_ms: gapMs },
    { slept_ms: gapMs },
    { slept_ms: gapMs },
  ]);
}

describe("clock gaps preserve human holds", () => {
  for (const [gapName, gapMs] of GAPS)
    for (const kind of HOLDS)
      for (const merging of [false, true])
        test(`repeated gaps ${gapName} keep a ${kind} hold${merging ? " with a merge checkpoint" : ""}`, async () => {
          const db = tempDb();
          try {
            const clock = new FakeClock(1_000_000);
            hold(db, clock.now(), kind, merging);
            const before = snapshot(db);

            await observeGaps(db, clock, gapMs);

            expect(snapshot(db)).toEqual(before);
            expect(executions(db)).toEqual([]);
            expect(actionableQuestions(db)).toHaveLength(kind === "awaiting_input" ? 1 : 0);
            if (kind === "awaiting_input") expect(findOpenQuestion(db, "session")).not.toBeNull();

            recoverOnStartup(db, clock.now());
            expect(requeueOrphanedWork(db, clock.now() + TWO_HOURS)).toEqual([]);
            expect(getWorkItem(db, "item")).toMatchObject(before.item);
            expect(executions(db)).toEqual([]);
            expect(actionableQuestions(db)).toHaveLength(kind === "awaiting_input" ? 1 : 0);
          } finally {
            db.close();
          }
        });

  for (const merging of [false, true])
    test(`after gaps, one authorized answer releases the question once${merging ? " with a merge checkpoint" : ""}`, async () => {
      const db = tempDb();
      try {
        const clock = new FakeClock(1_000_000);
        hold(db, clock.now(), "awaiting_input", merging);
        await observeGaps(db, clock, TWO_HOURS + 1);
        expect(executions(db)).toEqual([]);

        const reply = {
          sessionId: "session",
          deliveryId: "reply-1",
          body: "Go ahead",
          answeredBy: "lead",
          now: clock.now(),
        };
        const effects = () => questionEffects(db, { now: reply.now });
        expect(answer(db, reply, effects()).status).toBe("answered");
        const released = getWorkItem(db, "item")!;
        expect(released.state).toBe("queued");
        expect(executions(db).map((job) => job.jobKey)).toEqual([
          expect.stringMatching(/^resume:answer:/),
        ]);

        expect(answer(db, reply, effects()).status).toBe("duplicate");
        expect(answer(db, { ...reply, deliveryId: "reply-2" }, effects()).status).toBe("unasked");
        await observeGaps(db, clock, TWO_HOURS + 1);
        expect(getWorkItem(db, "item")?.version).toBe(released.version);
        expect(executions(db)).toHaveLength(1);
      } finally {
        db.close();
      }
    });

  test("an answer to a question cancelled during the hold does not release it", async () => {
    const db = tempDb();
    try {
      const clock = new FakeClock(1_000_000);
      hold(db, clock.now(), "awaiting_input", true);
      await observeGaps(db, clock, TWO_HOURS);
      db.run("UPDATE question SET cancelled_at=? WHERE item_id='item'", [clock.now()]);
      const before = snapshot(db);
      const reply = { sessionId: "session", deliveryId: "late", body: "Go", answeredBy: "lead" };
      expect(answer(db, reply, questionEffects(db, { now: clock.now() })).status).toBe("unasked");
      expect(snapshot(db)).toEqual(before);
      expect(executions(db)).toEqual([]);
    } finally {
      db.close();
    }
  });
});
