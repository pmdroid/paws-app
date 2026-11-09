import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND } from "../src/core";
import {
  enqueueJobSteps,
  getJobSteps,
  inMergeQueueSteps,
  joinMergeQueueSteps,
  keepMergeQueuePlaceSteps,
  leaveMergeQueueSteps,
  listMergeQueuesSteps,
  markMergeQueueNotifiedSteps,
  mergeQueueReadyTimesSteps,
  releaseMergeQueuePlaceSteps,
  restartedFromMergeQueueSteps,
  returnToMergeQueueSteps,
  wakeItemMergeSteps,
  wakeMergesBehindSteps,
  type Db,
} from "../src/db";
import { forEachDialect, insertWorkItem, seed } from "./dialects";

function setState(db: Db, id: string, state: string, project?: { id: string; name: string }) {
  return db.run(function* (q) {
    yield* q.exec(
      q.orm
        .update(q.t.workItem)
        .set({ state, linearProjectId: project?.id, linearProjectName: project?.name })
        .where(eq(q.t.workItem.id, id)),
    );
  });
}

const join = (db: Db, itemId: string, now: number, lane?: string) =>
  db.run((q) => joinMergeQueueSteps(q, { itemId, repository: "Acme/App", lane, now }));

forEachDialect((open) => {
  test("tasks queue per lane in ready order, verifying ones keep their place", async () => {
    const { db, close } = await open();
    try {
      for (const id of ["a", "b", "c", "d"]) await insertWorkItem(db, id);
      await setState(db, "a", "verifying");
      await setState(db, "b", "merge_queue");
      await setState(db, "c", "merge_queue", { id: "p1", name: "Project" });
      await setState(db, "d", "running");
      await join(db, "b", 20);
      await join(db, "a", 10);
      await join(db, "a", 30, "p1");
      await join(db, "c", 15, "p1");
      await join(db, "d", 5);
      await db.run((q) => markMergeQueueNotifiedSteps(q, "b", 2));

      expect(await db.run((q) => inMergeQueueSteps(q, "a"))).toBe(true);
      expect(await db.run((q) => inMergeQueueSteps(q, "d"))).toBe(false);
      expect(await db.run((q) => listMergeQueuesSteps(q))).toEqual([
        {
          itemId: "a",
          repository: "acme/app",
          lane: "",
          laneName: null,
          readyAt: 10,
          notifiedPosition: null,
          position: 1,
          total: 2,
          aheadItemId: null,
          busy: true,
          nextItemId: null,
        },
        {
          itemId: "b",
          repository: "acme/app",
          lane: "",
          laneName: null,
          readyAt: 20,
          notifiedPosition: 2,
          position: 2,
          total: 2,
          aheadItemId: "a",
          busy: false,
          nextItemId: null,
        },
        {
          itemId: "c",
          repository: "acme/app",
          lane: "p1",
          laneName: "Project",
          readyAt: 15,
          notifiedPosition: null,
          position: 1,
          total: 1,
          aheadItemId: null,
          busy: false,
          nextItemId: null,
        },
      ]);
      expect(
        (await db.run((q) => listMergeQueuesSteps(q, (id) => id === "a"))).map((p) => p.itemId),
      ).toEqual(["b", "c"]);
      expect(
        (await db.run(mergeQueueReadyTimesSteps)).sort((x, y) => x.readyAt - y.readyAt),
      ).toEqual([
        { itemId: "d", readyAt: 5 },
        { itemId: "a", readyAt: 10 },
        { itemId: "c", readyAt: 15 },
        { itemId: "b", readyAt: 20 },
      ]);
    } finally {
      await close();
    }
  });

  test("a kept place survives a release and returns once", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "a");
      await join(db, "a", 10);
      const queued = async () => (await db.run(mergeQueueReadyTimesSteps)).length;
      await db.run((q) => keepMergeQueuePlaceSteps(q, "a"));
      await db.run((q) => releaseMergeQueuePlaceSteps(q, "a"));
      expect(await queued()).toBe(1);
      await db.run((q) => returnToMergeQueueSteps(q, "a"));
      expect(await queued()).toBe(1);
      await db.run((q) => returnToMergeQueueSteps(q, "a"));
      expect(await queued()).toBe(0);
      await join(db, "a", 20);
      await db.run((q) => leaveMergeQueueSteps(q, "a"));
      expect(await queued()).toBe(0);
    } finally {
      await close();
    }
  });

  test("the latest restart came from the merge queue, directly or through its re-verify", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "a");
      let version = 0;
      const event = (fromState: string, toState: string, kind = "transition") =>
        seed(db, (q) =>
          q.orm.insert(q.t.workItemEvent).values({
            itemId: "a",
            version: (version += 1),
            at: version,
            fromState,
            toState,
            event: "e",
            kind,
            reason: kind === "restart" ? "ci" : null,
          }),
        );
      const restarted = () => db.run((q) => restartedFromMergeQueueSteps(q, "a"));
      expect(await restarted()).toBe(false);
      await event("merge_queue", "running", "restart");
      expect(await restarted()).toBe(true);
      await event("running", "verifying");
      await event("verifying", "running", "restart");
      expect(await restarted()).toBe(false);
      await event("merge_queue", "verifying");
      await event("verifying", "verifying");
      await event("verifying", "running", "restart");
      expect(await restarted()).toBe(true);
    } finally {
      await close();
    }
  });

  test("merge jobs parked behind a holder or dependencies run now", async () => {
    const { db, close } = await open();
    try {
      const merge = (reason: string) =>
        db.run((q) =>
          enqueueJobSteps(q, {
            queue: JOB_KIND.merge,
            payload: { mergeWait: { reason } },
            runAt: 100,
            now: 0,
          }),
        );
      const ahead = await merge("ahead");
      const dependencies = await merge("dependencies");
      const ci = await merge("ci");
      await db.run((q) => wakeMergesBehindSteps(q, 50));
      const runAt = async (id: number) => (await db.run((q) => getJobSteps(q, id)))?.runAt;
      expect([await runAt(ahead), await runAt(dependencies), await runAt(ci)]).toEqual([
        50, 50, 100,
      ]);
    } finally {
      await close();
    }
  });

  test("the item's parked merge job runs now once its conversation ends", async () => {
    const { db, close } = await open();
    try {
      const merge = (itemId: string) =>
        db.run((q) =>
          enqueueJobSteps(q, {
            queue: JOB_KIND.merge,
            payload: { itemId, mergeWait: { reason: "review" } },
            runAt: 100,
            now: 0,
          }),
        );
      const held = await merge("a");
      const other = await merge("b");
      expect(await db.run((q) => wakeItemMergeSteps(q, "a", 50))).toBe(true);
      expect(await db.run((q) => wakeItemMergeSteps(q, "c", 50))).toBe(false);
      const runAt = async (id: number) => (await db.run((q) => getJobSteps(q, id)))?.runAt;
      expect([await runAt(held), await runAt(other)]).toEqual([50, 100]);
    } finally {
      await close();
    }
  });
});
