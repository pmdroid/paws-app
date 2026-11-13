import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND, type RepositoryBinding, type WorkItemEvent } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  bindWorkItemRepository,
  endedCheckpointRefItems,
  insertQueuedItem,
  listJobs,
  type Db,
} from "../db";
import { seed, withoutForeignKeys } from "../../test/dialects";
import { tempStore } from "../../test/pglite";
import { deleteEndedCheckpointRef, sweepCheckpointRefs } from "./checkpoint-ref";

const REPOSITORY = { owner: "acme", repo: "repo", remoteUrl: "https://github.com/acme/repo.git" };

const PATHS: Record<"completed" | "merged" | "cancelled", WorkItemEvent[]> = {
  completed: ["dispatched", "answer_completed"],
  merged: ["dispatched", "closeout_accepted", "merge_accepted"],
  cancelled: ["dispatched", "cancel"],
};

async function apply(db: Db, id: string, events: WorkItemEvent[]) {
  for (const event of events) await applyWorkItemEvent(db, id, event, { now: 2 });
}

const end = (db: Db, id: string, state: keyof typeof PATHS) => apply(db, id, PATHS[state]);

async function setup() {
  const { db } = await tempStore();
  const item = await insertQueuedItem(db, { id: "item", branchName: "paws/item", now: 1 });
  await bindWorkItemRepository(db, item.id, REPOSITORY);
  const removed: { repository: RepositoryBinding; ref: string }[] = [];
  const remove = async (repository: RepositoryBinding, ref: string) => {
    removed.push({ repository, ref });
    return true;
  };
  const ended = () => endedCheckpointRefItems(db);
  return { db, item, removed, remove, ended };
}

async function continueBranch(db: Db, itemId: string, previousItemId: string) {
  await seed(db, (q) =>
    q.orm.insert(q.t.itemContinuation).values({ itemId, previousItemId, branch: "paws/item" }),
  );
}

for (const state of ["completed", "merged", "cancelled"] as const)
  test(`an item that ends ${state} has its hidden checkpoint ref deleted by the next sweep`, async () => {
    const { db, item, removed, remove, ended } = await setup();
    const events = PATHS[state];
    await apply(db, item.id, events.slice(0, -1));
    expect(await ended()).toEqual([]);
    await apply(db, item.id, events.slice(-1));
    expect(await ended()).toEqual([item.id]);
    await sweepCheckpointRefs({ store: db, remove });
    expect(removed).toEqual([
      { repository: expect.objectContaining(REPOSITORY), ref: "refs/paws/checkpoints/paws/item" },
    ]);
    expect(await ended()).toEqual([]);
    expect(await listJobs(db)).toEqual([]);
  });

test("a Stop records the deletion without closeStoppedPull", async () => {
  const { db, item, ended } = await setup();
  await applyWorkItemEvent(db, item.id, "cancel", { now: 2 });
  expect((await listJobs(db)).some((job) => job.queue === JOB_KIND.closeStoppedPull)).toBe(false);
  expect(await ended()).toEqual([item.id]);
});

test("a delete that fails stays for the next sweep", async () => {
  const { db, item, remove, removed, ended } = await setup();
  await end(db, item.id, "merged");
  await sweepCheckpointRefs({
    store: db,
    remove: async () => {
      throw new Error("GitHub is down");
    },
  });
  expect(await ended()).toEqual([item.id]);
  await sweepCheckpointRefs({ store: db, remove });
  expect(removed).toHaveLength(1);
  expect(await ended()).toEqual([]);
});

test("an item resumed before the sweep keeps its checkpoint", async () => {
  const { db, item, removed, remove } = await setup();
  await end(db, item.id, "cancelled");
  await db.run((q) =>
    q.exec(q.orm.update(q.t.workItem).set({ state: "queued" }).where(eq(q.t.workItem.id, item.id))),
  );
  expect(await deleteEndedCheckpointRef({ store: db, itemId: item.id, remove })).toBe("kept");
  expect(removed).toEqual([]);
});

test("a continuing item that took over the branch owns the checkpoint, until it ends too", async () => {
  const { db, item, removed, remove } = await setup();
  await end(db, item.id, "cancelled");
  const next = await insertQueuedItem(db, { id: "next", branchName: "paws/item", now: 3 });
  await continueBranch(db, next.id, item.id);
  expect(await deleteEndedCheckpointRef({ store: db, itemId: item.id, remove })).toBe("kept");
  expect(removed).toEqual([]);
  await end(db, next.id, "merged");
  expect(await deleteEndedCheckpointRef({ store: db, itemId: item.id, remove })).toBe("deleted");
});

test("a ref that is already gone is fine", async () => {
  const { db, item } = await setup();
  await end(db, item.id, "merged");
  expect(
    await deleteEndedCheckpointRef({ store: db, itemId: item.id, remove: async () => false }),
  ).toBe("absent");
});

test("a continuation two steps on that still runs keeps the shared checkpoint", async () => {
  const { db, item, removed, remove, ended } = await setup();
  const second = await insertQueuedItem(db, { id: "second", branchName: "paws/item", now: 2 });
  const third = await insertQueuedItem(db, { id: "third", branchName: "paws/item", now: 3 });
  await continueBranch(db, second.id, item.id);
  await continueBranch(db, third.id, second.id);
  for (const id of [item.id, second.id]) await end(db, id, "cancelled");
  await sweepCheckpointRefs({ store: db, remove });
  expect(removed).toEqual([]);
  expect(await ended()).toEqual([]);
});

test("a stop whose runner is still publishing its checkpoint waits for the next sweep", async () => {
  const { db, item, removed, remove, ended } = await setup();
  const { run } = await beginImplementRun(db, item.id, 2);
  await withoutForeignKeys(db);
  await seed(db, (q) =>
    q.orm.insert(q.t.runnerWork).values({
      runId: run.id,
      runnerId: "runner",
      workspaceId: "workspace",
      generation: 1,
      runnerFence: 0,
      commandId: "command",
      leaseUntil: 10,
    }),
  );
  await apply(db, item.id, ["cancel"]);
  const runnerWork = (set: { endedAt?: number; teardownConfirmedAt?: number }) =>
    db.run((q) =>
      q.exec(q.orm.update(q.t.runnerWork).set(set).where(eq(q.t.runnerWork.runId, run.id))),
    );
  await sweepCheckpointRefs({ store: db, remove });
  expect(removed).toEqual([]);
  expect(await ended()).toEqual([item.id]);
  await runnerWork({ endedAt: 20 });
  await sweepCheckpointRefs({ store: db, remove });
  expect(removed).toEqual([]);
  expect(await ended()).toEqual([item.id]);
  await runnerWork({ teardownConfirmedAt: 30 });
  await sweepCheckpointRefs({ store: db, remove });
  expect(removed).toHaveLength(1);
  expect(await ended()).toEqual([]);
});

test("a repository without a GitHub binding keeps its cleanup request for a later sweep", async () => {
  const { db, item, ended } = await setup();
  await end(db, item.id, "merged");
  await sweepCheckpointRefs({
    store: db,
    remove: () => Promise.reject(new Error("No GitHub App binding for acme/repo")),
  });
  expect(await ended()).toEqual([item.id]);
});
