import { describe, expect, test } from "bun:test";
import { and, asc, eq, gte, inArray, isNull } from "drizzle-orm";
import { FakeClock, JOB_KIND, type Checkpoint } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyWorkItemEvent,
  beginImplementRun,
  bindWorkItemRepository,
  emitJobReady,
  getRun,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listOutbox,
  markCloseoutAccepted,
  recoverOnStartup,
  requeueOrphanedWork,
  saveCheckpoint,
  type Db,
} from "../src/db";
import { HostSupervisor, WakeDetector } from "../src/host";
import { askSteps, attachOrchestrator, questionEffects } from "../src/loop";
import {
  answerSteps,
  findOpenQuestion,
  type AnswerEffects,
  type QuestionReply,
} from "../src/questions";
import { workspaceAdmission } from "./fake-workspace";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const loopAsk = (
  db: Db,
  ...args: Parameters<typeof askSteps> extends [unknown, ...infer R] ? R : never
) => db.transaction((q) => askSteps(q, ...args));

async function answer(db: Db, message: QuestionReply, effects: AnswerEffects = {}) {
  const outcome = await db.transaction((q) => answerSteps(q, message, effects));
  emitJobReady(db);
  return outcome;
}

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

async function seed(db: Db, now: number): Promise<void> {
  await insertQueuedItem(db, { id: "item", sessionKey: "session", now });
  await bindWorkItemRepository(db, "item", {
    owner: "owner",
    repo: "repo",
    remoteUrl: "https://example.invalid/repo.git",
  });
}

async function hold(db: Db, now: number, kind: Hold, merging: boolean): Promise<void> {
  await seed(db, now);
  const { run } = await beginImplementRun(db, "item", now, RUNNING);
  if (kind === "paused") await applyWorkItemEvent(db, "item", "pause", { now });
  if (kind === "manual") {
    await applyWorkItemEvent(db, "item", "run_failed", { now });
    await applyWorkItemEvent(db, "item", "take_over", { now });
  }
  if (kind === "awaiting_input") {
    if (merging) {
      await applyWorkItemEvent(db, "item", "turn_ended", { now });
      await applyWorkItemEvent(db, "item", "closeout_accepted", { now });
      await markCloseoutAccepted(db, "item", "wip");
      await loopAsk(
        db,
        { itemId: "item", runId: null, sessionId: "session" },
        "ci-help",
        "CI failed.",
        {
          now,
        },
      );
    } else {
      await loopAsk(
        db,
        { itemId: "item", runId: run.id, sessionId: "session" },
        "agent",
        "Archived?",
        {
          now,
        },
      );
    }
  }
  if (merging) {
    await markCloseoutAccepted(db, "item", "wip");
    await saveCheckpoint(db, "item", MERGING);
  }
  expect((await getWorkItem(db, "item"))?.state).toBe(kind);
}

async function executions(db: Db) {
  return (await listJobs(db)).filter(
    (job) =>
      EXECUTION.includes(job.queue) && (job.status === "pending" || job.status === "running"),
  );
}

function actionableQuestions(db: Db) {
  return db.run((q) =>
    q.all(
      q.orm
        .select({ id: q.t.question.id })
        .from(q.t.question)
        .where(
          and(
            eq(q.t.question.itemId, "item"),
            isNull(q.t.question.cancelledAt),
            inArray(q.t.question.status, ["open", "queued"]),
          ),
        ),
    ),
  );
}

async function snapshot(db: Db) {
  const item = (await getWorkItem(db, "item"))!;
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
    run: item.currentRunId ? (await getRun(db, item.currentRunId))?.status : null,
    jobs: (await listJobs(db))
      .filter((job) => job.queue !== JOB_KIND.catchup)
      .map((job) => ({ id: job.id, queue: job.queue, status: job.status, runAt: job.runAt })),
    questions: await db.run((q) =>
      q.all(
        q.orm
          .select({
            id: q.t.question.id,
            status: q.t.question.status,
            cancelledAt: q.t.question.cancelledAt,
          })
          .from(q.t.question)
          .where(eq(q.t.question.itemId, "item"))
          .orderBy(asc(q.t.question.id)),
      ),
    ),
    activities: (await listOutbox(db)).filter((message) => message.op !== "linear.catchup").length,
  };
}

function orchestrate(db: Db, clock: FakeClock) {
  const jobs = new JobLoop(db, clock);
  attachOrchestrator({
    store: db,
    jobs,
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: tempHome(),
    admission: workspaceAdmission(db),
    clock,
  });
  return jobs;
}

async function observeGaps(db: Db, clock: FakeClock, gapMs: number): Promise<void> {
  const host = new HostSupervisor(db, clock, new WakeDetector(clock), 250);
  const jobs = orchestrate(db, clock);
  const since = clock.now();
  try {
    await host.tick();
    for (let gap = 0; gap < 3; gap += 1) {
      clock.sleep(gapMs);
      await host.tick();
      clock.advance(250);
      await host.tick();
      await jobs.tick([JOB_KIND.catchup]);
    }
  } finally {
    host.stop();
  }
  expect(
    await db.run((q) =>
      q.all(
        q.orm
          .select({ sleptMs: q.t.wake.sleptMs })
          .from(q.t.wake)
          .where(gte(q.t.wake.fromWall, since))
          .orderBy(asc(q.t.wake.fromWall)),
      ),
    ),
  ).toEqual([{ sleptMs: gapMs }, { sleptMs: gapMs }, { sleptMs: gapMs }]);
}

describe("clock gaps preserve human holds", () => {
  for (const [gapName, gapMs] of GAPS)
    for (const kind of HOLDS)
      for (const merging of [false, true])
        test(`repeated gaps ${gapName} keep a ${kind} hold${merging ? " with a merge checkpoint" : ""}`, async () => {
          const { db, close } = await tempStore();
          try {
            const clock = new FakeClock(1_000_000);
            await hold(db, clock.now(), kind, merging);
            const before = await snapshot(db);

            await observeGaps(db, clock, gapMs);

            expect(await snapshot(db)).toEqual(before);
            expect(await executions(db)).toEqual([]);
            expect(await actionableQuestions(db)).toHaveLength(kind === "awaiting_input" ? 1 : 0);
            if (kind === "awaiting_input")
              expect(await findOpenQuestion(db, "session")).not.toBeNull();

            await recoverOnStartup(db, clock.now());
            expect(await requeueOrphanedWork(db, clock.now() + TWO_HOURS)).toEqual([]);
            expect(await getWorkItem(db, "item")).toMatchObject(before.item);
            expect(await executions(db)).toEqual([]);
            expect(await actionableQuestions(db)).toHaveLength(kind === "awaiting_input" ? 1 : 0);
          } finally {
            await close();
          }
        });

  for (const merging of [false, true])
    test(`after gaps, one authorized answer releases the question once${merging ? " with a merge checkpoint" : ""}`, async () => {
      const { db, close } = await tempStore();
      try {
        const clock = new FakeClock(1_000_000);
        await hold(db, clock.now(), "awaiting_input", merging);
        await observeGaps(db, clock, TWO_HOURS + 1);
        expect(await executions(db)).toEqual([]);

        const reply = {
          sessionId: "session",
          deliveryId: "reply-1",
          body: "Go ahead",
          answeredBy: "lead",
          now: clock.now(),
        };
        const effects = () => questionEffects(db, { now: reply.now });
        expect((await answer(db, reply, effects())).status).toBe("answered");
        const released = (await getWorkItem(db, "item"))!;
        expect(released.state).toBe("queued");
        expect((await executions(db)).map((job) => job.jobKey)).toEqual([
          expect.stringMatching(/^resume:answer:/),
        ]);

        expect((await answer(db, reply, effects())).status).toBe("duplicate");
        expect((await answer(db, { ...reply, deliveryId: "reply-2" }, effects())).status).toBe(
          "unasked",
        );
        await observeGaps(db, clock, TWO_HOURS + 1);
        expect((await getWorkItem(db, "item"))?.version).toBe(released.version);
        expect(await executions(db)).toHaveLength(1);
      } finally {
        await close();
      }
    });

  test("an answer to a question cancelled during the hold does not release it", async () => {
    const { db, close } = await tempStore();
    try {
      const clock = new FakeClock(1_000_000);
      await hold(db, clock.now(), "awaiting_input", true);
      await observeGaps(db, clock, TWO_HOURS);
      await db.run(function* (q) {
        yield* q.exec(
          q.orm
            .update(q.t.question)
            .set({ cancelledAt: clock.now() })
            .where(eq(q.t.question.itemId, "item")),
        );
      });
      const before = await snapshot(db);
      const reply = { sessionId: "session", deliveryId: "late", body: "Go", answeredBy: "lead" };
      expect((await answer(db, reply, questionEffects(db, { now: clock.now() }))).status).toBe(
        "unasked",
      );
      expect(await snapshot(db)).toEqual(before);
      expect(await executions(db)).toEqual([]);
    } finally {
      await close();
    }
  });
});
