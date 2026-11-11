import { expect, test } from "bun:test";
import { FakeClock, HANG_ASK_AFTER, JOB_KIND } from "../core";
import {
  beginImplementRun,
  consecutiveHangsSteps,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
  recordRunHangSteps,
  saveRunResult,
  sqliteDb,
} from "../db";
import { answerSteps } from "../questions";
import { askSteps } from "./operations";
import { questionEffects } from "./question-effects";
import { AGENT_HUNG_REASON, AGENT_HUNG_RETRY, AGENT_HUNG_STOP } from "./runner-wait";

async function hungItem(clock: FakeClock) {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = await insertQueuedItem(db, { id: "acme-7", sessionKey: "ses", now: clock.now() });
  return { db, item };
}

function addRun(db: ReturnType<typeof openDatabase>, itemId: string, id: string, at: number) {
  db.run(
    "INSERT INTO run(id,item_id,kind,agent,status,created_at,updated_at) VALUES(?,?,'implement','claude','lost',?,?)",
    [id, itemId, at, at],
  );
}

test("hang losses count across runs until a turn completes", async () => {
  const clock = new FakeClock(20_000);
  const { db, item } = await hungItem(clock);
  const store = sqliteDb(db);
  const hang = (runId: string) =>
    store.transaction((q) => recordRunHangSteps(q, runId, "runner-1", clock.now()));
  addRun(db, item.id, "run-a", 1);
  await hang("run-a");
  expect((await hang("run-a"))?.count).toBe(2);
  addRun(db, item.id, "run-b", 2);
  expect(await hang("run-b")).toEqual({
    count: HANG_ASK_AFTER,
    runIds: ["run-a", "run-b"],
    runnerId: "runner-1",
  });
  addRun(db, item.id, "run-c", 3);
  await saveRunResult(store, "run-c", "Done.", clock.now());
  addRun(db, item.id, "run-d", 4);
  expect(await hang("run-d")).toEqual({ count: 1, runIds: ["run-d"], runnerId: "runner-1" });
  expect(await store.run((q) => consecutiveHangsSteps(q, item.id))).toMatchObject({ count: 1 });
});

async function askHung(answer: string) {
  const clock = new FakeClock(20_000);
  const { db, item } = await hungItem(clock);
  const { run } = await beginImplementRun(sqliteDb(db), item.id, clock.now());
  await sqliteDb(db).transaction((q) =>
    askSteps(q, { itemId: item.id, runId: run.id, sessionId: "ses" }, "runner-wait", "Hung.", {
      options: [AGENT_HUNG_RETRY, AGENT_HUNG_STOP],
      reason: AGENT_HUNG_REASON,
      now: clock.now(),
    }),
  );
  expect((await getWorkItem(sqliteDb(db), item.id))?.state).toBe("awaiting_input");
  expect((await listJobs(sqliteDb(db))).filter((job) => job.status === "pending")).toEqual([]);
  clock.advance(60_000);
  const outcome = await sqliteDb(db).transaction((q) =>
    answerSteps(
      q,
      {
        sessionId: "ses",
        deliveryId: "reply",
        body: answer,
        answeredBy: "pascal",
        now: clock.now(),
      },
      questionEffects(sqliteDb(db), { now: clock.now() }),
    ),
  );
  expect(outcome.status).toBe("answered");
  return {
    state: (await getWorkItem(sqliteDb(db), item.id))?.state,
    jobs: await listJobs(sqliteDb(db)),
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
