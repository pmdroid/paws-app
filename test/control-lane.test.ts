import { expect, test } from "bun:test";
import {
  bindWorkItemRepository,
  enqueueJob,
  getJob,
  insertQueuedItem,
  JobLoop,
  listJobs,
} from "../src/db";
import { FakeClock, JOB_KIND } from "../src/core";
import { dispatch, saveSchedulingContext } from "../src/scheduler";
import { tempDb } from "./helpers";

const repository = { owner: "owner", repo: "repo", remoteUrl: "https://example.invalid/repo.git" };

test("reconciliation runs while every execution worker holds a handler open", async () => {
  const db = tempDb();
  const clock = new FakeClock(1000);
  const ids = ["a", "b", "c", "d", "e"];
  for (const [index, id] of ids.entries()) {
    insertQueuedItem(db, { id, now: index });
    bindWorkItemRepository(db, id, repository);
    saveSchedulingContext(db, { itemId: id, projectId: "project", paths: [`src/${id}.ts`] });
  }
  expect(dispatch(db, { now: clock.now() })).toEqual(ids);
  const loop = new JobLoop(db, clock, { concurrency: 4, pollMs: 1 });
  const held: string[] = [];
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  loop.register(JOB_KIND.start, async (job) => {
    held.push(String((job.payload as { itemId: string }).itemId));
    await released;
  });
  let reconciled!: () => void;
  const reconciliation = new Promise<boolean>((resolve) => (reconciled = () => resolve(true)));
  loop.register("execution.reconcile", () => reconciled());
  const controller = new AbortController();
  const running = loop.run(controller.signal, (ms) => Bun.sleep(ms));
  for (let attempt = 0; attempt < 200 && held.length < 4; attempt++) await Bun.sleep(5);
  await Bun.sleep(20);
  expect(held.sort()).toEqual(ids.slice(0, 4));
  const id = enqueueJob(db, { queue: "execution.reconcile", priority: 0, now: clock.now() });
  expect(await Promise.race([reconciliation, Bun.sleep(1000).then(() => false)])).toBe(true);
  expect(getJob(db, id)?.status).toBe("done");
  expect(held.length).toBe(4);
  expect(
    listJobs(db).filter((job) => job.queue === JOB_KIND.start && job.status === "running"),
  ).toHaveLength(4);
  release();
  controller.abort();
  await running;
  db.close();
});
