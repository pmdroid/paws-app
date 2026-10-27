import { afterEach, describe, expect, test } from "bun:test";
import { JOB_KIND, MERGE_LANE } from "../core";
import {
  enqueueJob,
  getWorkItem,
  listJobs,
  listMergeQueues,
  recordRebaseReturn,
  returnToMergeQueue,
} from "../db";
import { findOpenQuestion } from "../questions";
import { mergeHarness, pendingCi, type MergeHarness } from "./advance-harness";
import { MAX_REBASE_RETURNS } from "./budget";
import { REBASE_CONFLICT_INSTRUCTION, REBASE_CONFLICT_THOUGHT } from "./orders";
import { mainMoved } from "./queue-conflicts";
import type { MergeStep } from "./step";

let harness: MergeHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

async function start(): Promise<MergeHarness> {
  harness = await mergeHarness({ settings: { order: "queue" } });
  return harness;
}

function queued(h: MergeHarness): string[] {
  return listMergeQueues(h.db).map((entry) => entry.itemId);
}

function restarts(h: MergeHarness) {
  return listJobs(h.db)
    .filter((job) => job.queue === JOB_KIND.resume)
    .map((job) => job.payload as { itemId: string; handoff: string; reason: string });
}

function sweeps(h: MergeHarness) {
  return listJobs(h.db).filter((job) => job.queue === JOB_KIND.queueConflicts);
}

/** Three tasks in the acme/app queue; the third changes the file main is about to change. */
async function threeQueued(h: MergeHarness): Promise<void> {
  await h.addItem("ENG-1");
  await h.addItem("ENG-2");
  await h.addItem("ENG-3", { file: "ok.txt", content: "third\n" });
  h.state.ci = pendingCi;
  for (const id of ["ENG-1", "ENG-2", "ENG-3"]) {
    await h.pass(id);
    h.clock.advance(1_000);
  }
  expect(queued(h)).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
}

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; !condition(); tries++) {
    if (tries > 500) throw new Error("timed out");
    await Bun.sleep(10);
  }
}

describe("queued pull requests that conflict with main", () => {
  test("go back for a rebase while the front merges; the one only behind main is left alone", async () => {
    const h = await start();
    let release = () => {};
    h.state.squashGate = new Promise((resolve) => {
      release = resolve;
    });
    await threeQueued(h);
    h.state.ci = () => undefined;
    const front: Promise<MergeStep> = h.pass("ENG-1");
    await until(() => h.state.squashing);
    expect(queued(h)).toEqual(["ENG-1", "ENG-2", "ENG-3"]);

    const main = await h.moveMain("ok.txt", "main moved\n");
    h.state.lazyMergeable.set(3, 2);
    mainMoved(h.db, { repository: "acme/app", main, now: h.clock.now() });
    expect(sweeps(h)).toHaveLength(1);
    expect(await h.sweep(main)).toEqual(["ENG-3"]);

    expect(getWorkItem(h.db, "ENG-3")?.state).toBe("queued");
    expect(restarts(h)).toEqual([
      expect.objectContaining({
        itemId: "ENG-3",
        reason: "conflict",
        handoff: REBASE_CONFLICT_INSTRUCTION,
      }),
    ]);
    expect(h.state.pullReads.get(3)).toBe(3);
    expect(getWorkItem(h.db, "ENG-2")?.state).toBe("merge_queue");
    expect(h.state.pullReads.get(2)).toBe(1);
    expect(h.state.pullReads.has(1)).toBe(false);
    expect(h.bodies("thought")).toEqual([REBASE_CONFLICT_THOUGHT]);
    expect(h.github.merged).toEqual([]);

    release();
    expect(await front).toEqual({ kind: "merged" });
    expect(h.github.merged.map((merge) => merge.number)).toEqual([1]);
  });

  test("a redelivered main move or a second check of the same head sends the task back once", async () => {
    const h = await start();
    await threeQueued(h);
    const main = await h.moveMain("ok.txt", "main moved\n");
    mainMoved(h.db, { repository: "acme/app", main, now: h.clock.now() });
    mainMoved(h.db, { repository: "acme/app", main, now: h.clock.now() + 5 });
    expect(sweeps(h)).toHaveLength(1);

    expect(await h.sweep(main)).toEqual(["ENG-3"]);
    expect(await h.sweep(main)).toEqual([]);
    expect(restarts(h).map((payload) => payload.itemId)).toEqual(["ENG-3"]);

    // Back in the queue on the same head: main moves again and it still conflicts.
    await h.requeue("ENG-3");
    returnToMergeQueue(h.db, "ENG-3");
    const again = await h.moveMain("README.md", "main again\n");
    expect(await h.sweep(again)).toEqual([]);
    expect(getWorkItem(h.db, "ENG-3")?.state).toBe("merge_queue");
    expect(restarts(h).map((payload) => payload.itemId)).toEqual(["ENG-3"]);
    expect(h.bodies("thought")).toEqual([REBASE_CONFLICT_THOUGHT]);
  });

  test("the task sent back keeps its place for when Closeout accepts its rebased head", async () => {
    const h = await start();
    await threeQueued(h);
    const main = await h.moveMain("ok.txt", "main moved\n");
    expect(await h.sweep(main)).toEqual(["ENG-3"]);
    expect(queued(h)).toEqual(["ENG-1", "ENG-2"]);

    await h.addItem("ENG-4");
    h.clock.advance(1_000);
    await h.pass("ENG-4");
    expect(queued(h)).toEqual(["ENG-1", "ENG-2", "ENG-4"]);

    await h.requeue("ENG-3");
    returnToMergeQueue(h.db, "ENG-3");
    expect(queued(h)).toEqual(["ENG-1", "ENG-2", "ENG-3", "ENG-4"]);
    expect(await h.pass("ENG-3")).toMatchObject({
      kind: "wait",
      reason: "ahead",
      message: "Third in the acme/app queue. ENG-2 merges first.",
    });
    expect(queued(h)).toEqual(["ENG-1", "ENG-2", "ENG-3", "ENG-4"]);

    // The kept place is spent: a later return to the agent leaves the queue as before.
    h.db.run("UPDATE work_item SET state = 'verifying' WHERE id = 'ENG-3'");
    returnToMergeQueue(h.db, "ENG-3");
    expect(queued(h)).toEqual(["ENG-1", "ENG-2", "ENG-4"]);
  });

  test("a task whose merge starts while its pull request is read is left to the lane", async () => {
    const h = await start();
    await threeQueued(h);
    for (let round = 1; round <= MAX_REBASE_RETURNS; round++)
      recordRebaseReturn(h.db, {
        itemId: "ENG-2",
        jobId: 900 + round,
        candidate: `old-${round}`,
        reason: "merge",
        base: `main-${round}`,
        files: ["ok.txt"],
        recordedAt: h.clock.now() - 2 * 60 * 60 * 1000,
      });
    await h.moveMain("ok.txt", "main moved\n");
    await h.git(h.bare, "update-ref", "refs/heads/paws/ENG-2", "refs/heads/paws/ENG-3");
    h.state.onPullRead = (number) => {
      const itemId = `ENG-${number}`;
      const id = enqueueJob(h.db, {
        queue: JOB_KIND.merge,
        lane: MERGE_LANE,
        payload: { itemId },
        now: h.clock.now(),
      });
      h.db.run("UPDATE job SET status = 'running' WHERE id = ?", [id]);
    };
    expect(await h.sweep(null)).toEqual([]);
    expect(restarts(h)).toEqual([]);
    expect(findOpenQuestion(h.db, "ses-ENG-2")).toBeNull();
    expect(getWorkItem(h.db, "ENG-2")?.state).toBe("merge_queue");
    expect(getWorkItem(h.db, "ENG-3")?.state).toBe("merge_queue");
    expect(h.bodies("thought")).toEqual([]);
  });

  test("a spent rebase budget asks instead of sending the task back", async () => {
    const h = await start();
    await threeQueued(h);
    for (let round = 1; round <= MAX_REBASE_RETURNS; round++)
      recordRebaseReturn(h.db, {
        itemId: "ENG-3",
        jobId: 900 + round,
        candidate: `old-${round}`,
        reason: "merge",
        base: `main-${round}`,
        files: ["ok.txt"],
        recordedAt: h.clock.now() - 2 * 60 * 60 * 1000,
      });
    const main = await h.moveMain("ok.txt", "main moved\n");
    expect(await h.sweep(main)).toEqual(["ENG-3"]);
    expect(restarts(h)).toEqual([]);
    expect(getWorkItem(h.db, "ENG-3")?.state).toBe("awaiting_input");
    expect(findOpenQuestion(h.db, "ses-ENG-3")?.body).toContain(
      `The branch still conflicts with main after ${MAX_REBASE_RETURNS} attempts`,
    );
  });

  test("main moving with nothing behind the front enqueues no check", async () => {
    const h = await start();
    await h.addItem("ENG-1");
    h.state.ci = pendingCi;
    await h.pass("ENG-1");
    expect(queued(h)).toEqual(["ENG-1"]);
    mainMoved(h.db, { repository: "acme/app", main: "a".repeat(40), now: h.clock.now() });
    expect(sweeps(h)).toEqual([]);
  });
});
