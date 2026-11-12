import { workspaceDispatchPg } from "./fake-workspace";
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
import { saveSchedulingContextSteps } from "../src/scheduler";
import { tempStore } from "./pglite";

const repository = { owner: "owner", repo: "repo", remoteUrl: "https://example.invalid/repo.git" };

test("reconciliation runs while every execution worker holds a handler open", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(1000);
  const ids = ["a", "b", "c", "d", "e"];
  for (const [index, id] of ids.entries()) {
    await insertQueuedItem(db, { id, now: index });
    await bindWorkItemRepository(db, id, repository);
    await db.run((q) =>
      saveSchedulingContextSteps(q, { itemId: id, projectId: "project", paths: [`src/${id}.ts`] }),
    );
  }
  expect(await workspaceDispatchPg(db, { now: clock.now() })).toEqual(ids);
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
  const id = await enqueueJob(db, {
    queue: "execution.reconcile",
    priority: 0,
    now: clock.now(),
  });
  expect(await Promise.race([reconciliation, Bun.sleep(1000).then(() => false)])).toBe(true);
  // The loop awaits the database after the handler returns, so completion lands a few ticks later.
  for (let attempt = 0; attempt < 50 && (await getJob(db, id))?.status !== "done"; attempt++)
    await Bun.sleep(1);
  expect((await getJob(db, id))?.status).toBe("done");
  expect(held.length).toBe(4);
  expect(
    (await listJobs(db)).filter((job) => job.queue === JOB_KIND.start && job.status === "running"),
  ).toHaveLength(4);
  release();
  controller.abort();
  await running;
  await close();
});
