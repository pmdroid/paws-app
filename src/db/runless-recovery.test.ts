import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND } from "../core";
import {
  beginImplementRun,
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  markRun,
  requeueOrphanedWork,
  type Db,
} from "./index";
import { seed } from "../../test/pglite-fixtures";
import { tempStore } from "../../test/pglite";

const MINUTE = 60_000;
const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

function finishJob(db: Db, id: number, finishedAt: number) {
  return seed(db, (q) =>
    q.orm.update(q.t.job).set({ status: "done", finishedAt }).where(eq(q.t.job.id, id)),
  );
}

async function runningWithoutRun() {
  const { db, close } = await tempStore();
  open.push(close);
  await insertQueuedItem(db, { id: "item", sessionKey: "ses", now: 1 });
  const { run } = await beginImplementRun(db, "item", 1);
  await markRun(db, run.id, "ended", 1_000);
  const job = await enqueueJob(db, {
    queue: JOB_KIND.resume,
    payload: { itemId: "item" },
    now: 1_000,
  });
  await finishJob(db, job, 1_000);
  return { db, runId: run.id };
}

const runless = async (db: Db) =>
  (await listJobs(db)).filter((job) => job.jobKey?.startsWith("runless:item:"));

test("a running item without an active run gets one fresh run from the sweep after 10 minutes", async () => {
  const { db, runId } = await runningWithoutRun();
  expect(await requeueOrphanedWork(db, 1_000 + 9 * MINUTE)).toEqual([]);
  expect(await runless(db)).toEqual([]);
  expect(await requeueOrphanedWork(db, 1_001 + 10 * MINUTE)).toEqual(["item"]);
  const [job] = await runless(db);
  expect(job).toMatchObject({
    queue: JOB_KIND.resume,
    status: "pending",
    payload: { itemId: "item", runId, freshRun: true, reason: "orphaned" },
  });
  expect(await requeueOrphanedWork(db, 1_001 + 20 * MINUTE)).toEqual([]);
  expect(await runless(db)).toHaveLength(1);
});

test("a second runless breach within the hour asks instead of restarting", async () => {
  const { db } = await runningWithoutRun();
  expect(await requeueOrphanedWork(db, 1_001 + 10 * MINUTE)).toEqual(["item"]);
  await finishJob(db, (await runless(db))[0]!.id, 1_001 + 10 * MINUTE);
  expect(await requeueOrphanedWork(db, 1_002 + 20 * MINUTE)).toEqual([]);
  expect(await runless(db)).toHaveLength(1);
  expect((await getWorkItem(db, "item"))?.state).toBe("recovering");
  expect(
    (await listJobs(db)).find((job) => job.queue === "item.ask" && job.status === "pending")
      ?.payload,
  ).toMatchObject({ itemId: "item", reason: "restart" });
});

test("the sweep leaves a runless item alone while a start for it is pending", async () => {
  const { db } = await runningWithoutRun();
  await enqueueJob(db, { queue: JOB_KIND.resume, payload: { itemId: "item" }, now: 2_000 });
  expect(await requeueOrphanedWork(db, 1_001 + 30 * MINUTE)).toEqual([]);
  expect(await runless(db)).toEqual([]);
});
