import { expect, test } from "bun:test";
import { JOB_KIND, type RepositoryBinding } from "../core";
import {
  applyWorkItemEvent,
  bindWorkItemRepository,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
} from "../db";
import { deleteEndedCheckpointRef } from "./checkpoint-ref";

const REPOSITORY = { owner: "acme", repo: "repo", remoteUrl: "https://github.com/acme/repo.git" };

function setup() {
  const db = openDatabase(":memory:");
  migrate(db);
  const item = insertQueuedItem(db, { id: "item", branchName: "paws/item", now: 1 });
  bindWorkItemRepository(db, item.id, REPOSITORY);
  const removed: { repository: RepositoryBinding; ref: string }[] = [];
  const remove = async (repository: RepositoryBinding, ref: string) => {
    removed.push({ repository, ref });
    return true;
  };
  const deleteJobs = () => listJobs(db).filter((job) => job.queue === JOB_KIND.deleteCheckpointRef);
  return { db, item, removed, remove, deleteJobs };
}

for (const state of ["completed", "merged", "cancelled"] as const)
  test(`an item that ends ${state} queues the deletion of its hidden checkpoint ref`, async () => {
    const { db, item, removed, remove, deleteJobs } = setup();
    db.run("UPDATE work_item SET state='running', version=version+1 WHERE id=?", [item.id]);
    expect(deleteJobs()).toEqual([]);
    db.run("UPDATE work_item SET state=?, version=version+1 WHERE id=?", [state, item.id]);
    expect(deleteJobs().map((job) => job.payload)).toEqual([{ checkpointRefFor: item.id }]);
    expect(await deleteEndedCheckpointRef({ db, itemId: item.id, remove })).toBe("deleted");
    expect(removed).toEqual([
      { repository: expect.objectContaining(REPOSITORY), ref: "refs/paws/checkpoints/paws/item" },
    ]);
  });

test("a Stop queues the deletion without closeStoppedPull, and the stop does not cancel it", () => {
  const { db, item, deleteJobs } = setup();
  applyWorkItemEvent(db, item.id, "cancel", { now: 2 });
  expect(listJobs(db).some((job) => job.queue === JOB_KIND.closeStoppedPull)).toBe(false);
  expect(deleteJobs().map((job) => job.status)).toEqual(["pending"]);
});

test("an item resumed before the job runs keeps its checkpoint", async () => {
  const { db, item, removed, remove } = setup();
  db.run("UPDATE work_item SET state='cancelled', version=version+1 WHERE id=?", [item.id]);
  db.run("UPDATE work_item SET state='queued', version=version+1 WHERE id=?", [item.id]);
  expect(await deleteEndedCheckpointRef({ db, itemId: item.id, remove })).toBe("kept");
  expect(removed).toEqual([]);
});

test("a continuing item that took over the branch owns the checkpoint, until it ends too", async () => {
  const { db, item, removed, remove } = setup();
  db.run("UPDATE work_item SET state='cancelled', version=version+1 WHERE id=?", [item.id]);
  const next = insertQueuedItem(db, { id: "next", branchName: "paws/item", now: 3 });
  db.run("INSERT INTO item_continuation(item_id,previous_item_id,branch) VALUES(?,?,?)", [
    next.id,
    item.id,
    "paws/item",
  ]);
  expect(await deleteEndedCheckpointRef({ db, itemId: item.id, remove })).toBe("kept");
  expect(removed).toEqual([]);
  db.run("UPDATE work_item SET state='merged', version=version+1 WHERE id=?", [next.id]);
  expect(await deleteEndedCheckpointRef({ db, itemId: item.id, remove })).toBe("deleted");
});

test("a ref that is already gone is fine", async () => {
  const { db, item } = setup();
  db.run("UPDATE work_item SET state='merged', version=version+1 WHERE id=?", [item.id]);
  expect(await deleteEndedCheckpointRef({ db, itemId: item.id, remove: async () => false })).toBe(
    "absent",
  );
});
