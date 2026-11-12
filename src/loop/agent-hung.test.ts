import { afterEach, expect, test } from "bun:test";
import { FakeClock, HANG_ASK_AFTER, JOB_KIND } from "../core";
import {
  beginImplementRun,
  consecutiveHangsSteps,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  recordRunHangSteps,
  saveRunResult,
  type Db,
} from "../db";
import { answerSteps } from "../questions";
import { askSteps } from "./operations";
import { questionEffects } from "./question-effects";
import { AGENT_HUNG_REASON, AGENT_HUNG_RETRY, AGENT_HUNG_STOP } from "./runner-wait";
import { seed } from "../../test/dialects";
import { tempStore } from "../../test/pglite";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function hungItem(clock: FakeClock) {
  const { db, close } = await tempStore();
  open.push(close);
  const item = await insertQueuedItem(db, { id: "acme-7", sessionKey: "ses", now: clock.now() });
  return { db, item };
}

function addRun(db: Db, itemId: string, id: string, at: number) {
  return seed(db, (q) =>
    q.orm.insert(q.t.run).values({
      id,
      itemId,
      kind: "implement",
      agent: "claude",
      status: "lost",
      createdAt: at,
      updatedAt: at,
    }),
  );
}

test("hang losses count across runs until a turn completes", async () => {
  const clock = new FakeClock(20_000);
  const { db, item } = await hungItem(clock);
  const hang = (runId: string) =>
    db.transaction((q) => recordRunHangSteps(q, runId, "runner-1", clock.now()));
  await addRun(db, item.id, "run-a", 1);
  await hang("run-a");
  expect((await hang("run-a"))?.count).toBe(2);
  await addRun(db, item.id, "run-b", 2);
  expect(await hang("run-b")).toEqual({
    count: HANG_ASK_AFTER,
    runIds: ["run-a", "run-b"],
    runnerId: "runner-1",
  });
  await addRun(db, item.id, "run-c", 3);
  await saveRunResult(db, "run-c", "Done.", clock.now());
  await addRun(db, item.id, "run-d", 4);
  expect(await hang("run-d")).toEqual({ count: 1, runIds: ["run-d"], runnerId: "runner-1" });
  expect(await db.run((q) => consecutiveHangsSteps(q, item.id))).toMatchObject({ count: 1 });
});

async function askHung(answer: string) {
  const clock = new FakeClock(20_000);
  const { db, item } = await hungItem(clock);
  const { run } = await beginImplementRun(db, item.id, clock.now());
  await db.transaction((q) =>
    askSteps(q, { itemId: item.id, runId: run.id, sessionId: "ses" }, "runner-wait", "Hung.", {
      options: [AGENT_HUNG_RETRY, AGENT_HUNG_STOP],
      reason: AGENT_HUNG_REASON,
      now: clock.now(),
    }),
  );
  expect((await getWorkItem(db, item.id))?.state).toBe("awaiting_input");
  expect((await listJobs(db)).filter((job) => job.status === "pending")).toEqual([]);
  clock.advance(60_000);
  const outcome = await db.transaction((q) =>
    answerSteps(
      q,
      {
        sessionId: "ses",
        deliveryId: "reply",
        body: answer,
        answeredBy: "pascal",
        now: clock.now(),
      },
      questionEffects(db, { now: clock.now() }),
    ),
  );
  expect(outcome.status).toBe("answered");
  return {
    state: (await getWorkItem(db, item.id))?.state,
    jobs: await listJobs(db),
  };
}

test("Retry on a hung agent restarts the item once", async () => {
  const { state, jobs } = await askHung(AGENT_HUNG_RETRY);
  expect(state).toBe("queued");
  expect(
    jobs.filter((job) => job.queue === JOB_KIND.resume && job.status === "pending"),
  ).toHaveLength(1);
});

test("Stop on a hung agent pauses the item", async () => {
  const { state, jobs } = await askHung(AGENT_HUNG_STOP);
  expect(state).toBe("paused");
  expect(jobs.filter((job) => job.status === "pending")).toEqual([]);
});
