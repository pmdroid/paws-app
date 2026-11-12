import { workspaceDispatchPg } from "./fake-workspace";
import { expect, test } from "bun:test";
import { bindWorkItemRepository, insertQueuedItem, listJobs, startLoops } from "../src/db";
import { JOB_KIND } from "../src/core";
import { saveSchedulingContextSteps } from "../src/scheduler";
import { tempStore } from "./pglite";

const repository = { owner: "owner", repo: "repo", remoteUrl: "https://example.invalid/repo.git" };

test("Paws runs more task starts at once than the four workers it used to have", async () => {
  const { db, close } = await tempStore();
  const ids = Array.from({ length: 10 }, (_, index) => `item-${index}`);
  for (const [index, id] of ids.entries()) {
    await insertQueuedItem(db, { id, now: index });
    await bindWorkItemRepository(db, id, repository);
    await db.run((q) =>
      saveSchedulingContextSteps(q, { itemId: id, projectId: "project", paths: [`src/${id}.ts`] }),
    );
  }
  expect(await workspaceDispatchPg(db, { now: Date.now() })).toEqual(ids);
  const controller = new AbortController();
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const held: string[] = [];
  const loops = await startLoops({
    db,
    instanceId: "01JINSTANCEACME0000000000",
    signal: controller.signal,
    prepare({ jobs }) {
      jobs.register(JOB_KIND.start, async (job) => {
        held.push(String((job.payload as { itemId: string }).itemId));
        await released;
      });
    },
  });
  for (let attempt = 0; attempt < 400 && held.length < ids.length; attempt++) await Bun.sleep(5);
  expect(held.sort()).toEqual([...ids].sort());
  expect(
    (await listJobs(db)).filter((job) => job.queue === JOB_KIND.start && job.status === "running"),
  ).toHaveLength(ids.length);
  release();
  controller.abort();
  await loops.stop();
  await close();
});
