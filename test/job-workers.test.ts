import { workspaceDispatch } from "./fake-workspace";
import { expect, test } from "bun:test";
import { bindWorkItemRepository, insertQueuedItem, listJobs, startLoops } from "../src/db";
import { JOB_KIND } from "../src/core";
import { saveSchedulingContext } from "../src/scheduler";
import { tempDb } from "./helpers";

const repository = { owner: "owner", repo: "repo", remoteUrl: "https://example.invalid/repo.git" };

test("Paws runs more task starts at once than the four workers it used to have", async () => {
  const db = tempDb();
  const ids = Array.from({ length: 10 }, (_, index) => `item-${index}`);
  for (const [index, id] of ids.entries()) {
    insertQueuedItem(db, { id, now: index });
    bindWorkItemRepository(db, id, repository);
    saveSchedulingContext(db, { itemId: id, projectId: "project", paths: [`src/${id}.ts`] });
  }
  expect(workspaceDispatch(db, { now: Date.now() })).toEqual(ids);
  const controller = new AbortController();
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const held: string[] = [];
  const loops = startLoops({
    db,
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
    listJobs(db).filter((job) => job.queue === JOB_KIND.start && job.status === "running"),
  ).toHaveLength(ids.length);
  release();
  controller.abort();
  await loops.stop();
  db.close();
});
