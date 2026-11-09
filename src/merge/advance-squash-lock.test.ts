import { afterEach, describe, expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  acquireRepositoryMergeLock,
  claimNextJob,
  enqueueJob,
  getJob,
  getConfirmedRemoteMerge,
  getWorkItem,
  mergeCallInFlight,
  readRepositoryMergeLock,
  saveWorkItemLinearProject,
  sqliteDb,
} from "../db";
import { createFakeMergeQueue } from "../github";
import { mergeHarness, type MergeHarness } from "./advance-harness";
import {
  SQUASH_LOCK_OUTCOME_TTL_MS,
  SQUASH_LOCK_POLL_MS,
  SQUASH_LOCK_RETRY_MS,
  SQUASH_LOCK_TTL_MS,
  SQUASH_LOCK_WAIT_MS,
} from "./repository-lock";
import { parkMerge } from "./wait";

let harness: MergeHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

async function start(options: Parameters<typeof mergeHarness>[0] = {}) {
  harness = await mergeHarness(options);
  return harness;
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let tries = 0; !condition(); tries++) {
    if (tries > 500) throw new Error(`${what} did not happen`);
    await Bun.sleep(10);
  }
}

function lock(h: MergeHarness, repository = "acme/app") {
  return readRepositoryMergeLock(sqliteDb(h.db), repository);
}

function holdLock(h: MergeHarness, repository: string) {
  return acquireRepositoryMergeLock(sqliteDb(h.db), {
    repository,
    holder: "other-instance:job-99:turn",
    itemId: "ENG-99",
    jobId: 99,
    instanceId: "other-instance",
    now: h.clock.now(),
    ttlMs: SQUASH_LOCK_TTL_MS,
  });
}

function mergedOrder(h: MergeHarness, ids: string[]): string[] {
  return h.github.merged.map((merge) => ids[merge.number - 1]!);
}

describe.each(["queue", "ci-green"] as const)(
  "the repository squash lock with order %s",
  (order) => {
    test("a second lane of the same repository squashes only after the first releases the lock", async () => {
      const h = await start({ settings: { order, mainMoved: "ci" } });
      const ids = ["ENG-1", "ENG-2"];
      for (const id of ids) await h.addItem(id);
      if (order === "queue")
        for (const [id, lane] of [
          ["ENG-1", "project-a"],
          ["ENG-2", "project-b"],
        ] as const) {
          h.state.lanes.set(id, lane);
          saveWorkItemLinearProject(h.db, id, { id: lane, name: lane });
        }

      let releaseFirst = () => {};
      h.state.squashGate = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const first = h.pass("ENG-1");
      await until(() => h.state.squashing, "the first squash");
      h.state.squashGate = null;
      expect(await lock(h)).toMatchObject({ itemId: "ENG-1" });

      let wakeSecond = () => {};
      h.state.lockSleep = () =>
        new Promise<void>((resolve) => {
          wakeSecond = resolve;
        });
      const second = h.pass("ENG-2");
      await until(() => h.state.lockSleeps.length > 0, "the second lane's wait for the lock");
      expect(h.state.lockSleeps).toEqual([SQUASH_LOCK_POLL_MS]);
      expect(h.github.merged).toEqual([]);

      h.state.lockSleep = async () => {};
      releaseFirst();
      expect(await first).toEqual({ kind: "merged" });
      expect(await lock(h)).toBeNull();
      await h.moveMain("lane-a.txt", "lane a\n");
      wakeSecond();
      expect(await second).toMatchObject({
        kind: "wait",
        reason: "ci",
        message: "Main moved before the merge. Reading it again.",
      });
      expect(mergedOrder(h, ids)).toEqual(["ENG-1"]);
      expect(await lock(h)).toBeNull();

      let step = await h.pass("ENG-2");
      for (let pass = 0; pass < 3 && step.kind === "wait"; pass++) step = await h.pass("ENG-2");
      expect(step).toEqual({ kind: "merged" });
      expect(mergedOrder(h, ids)).toEqual(["ENG-1", "ENG-2"]);
      const rebased = await h.remoteHead("ENG-2");
      expect(h.github.merged.at(-1)?.expectedHeadSha).toBe(rebased);
      await h.git(h.bare, "merge-base", "--is-ancestor", "refs/heads/main", rebased);
    });
  },
);

describe("the repository squash lock", () => {
  test("a lock another instance holds makes the lane wait briefly, and an expired one is taken over", async () => {
    const h = await start({ settings: { order: "queue" } });
    await h.addItem("ENG-1");
    expect(await holdLock(h, "acme/app")).toBe(true);

    expect(await h.pass("ENG-1")).toEqual({
      kind: "wait",
      reason: "repository_lock",
      message: "Another task is merging into acme/app. Merging after it.",
    });
    expect(h.state.lockSleeps).toHaveLength(SQUASH_LOCK_WAIT_MS / SQUASH_LOCK_POLL_MS);
    expect(h.github.merged).toEqual([]);
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("merge_queue");
    expect(await lock(h)).toMatchObject({ holder: "other-instance:job-99:turn" });

    h.clock.advance(SQUASH_LOCK_TTL_MS);
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged).toHaveLength(1);
    expect(await lock(h)).toBeNull();
  });

  test("a squash whose outcome GitHub has not confirmed keeps the lock until the merge is recorded", async () => {
    const h = await start({ settings: { order: "ci-green", mainMoved: "ci" } });
    const ids = ["ENG-1", "ENG-2"];
    for (const id of ids) await h.addItem(id);
    h.state.mergeResponseStatus = 502;
    h.state.mergeReadUnknown = true;
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "merge_outcome" });
    expect(mergeCallInFlight(h.db, "ENG-1")).toBe(true);
    expect(await lock(h)).toMatchObject({
      itemId: "ENG-1",
      expiresAt: h.clock.now() + SQUASH_LOCK_OUTCOME_TTL_MS,
    });

    h.state.mergeResponseStatus = 200;
    expect(await h.pass("ENG-2")).toEqual({
      kind: "wait",
      reason: "repository_lock",
      message: "Another task is merging into acme/app. Merging after it.",
    });
    expect(mergedOrder(h, ids)).toEqual(["ENG-1"]);

    h.clock.advance(SQUASH_LOCK_TTL_MS);
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "merge_outcome" });
    expect(await lock(h)).toMatchObject({
      itemId: "ENG-1",
      expiresAt: h.clock.now() + SQUASH_LOCK_OUTCOME_TTL_MS,
    });
    h.clock.advance(SQUASH_LOCK_TTL_MS);
    expect(await h.pass("ENG-2")).toMatchObject({ kind: "wait", reason: "repository_lock" });
    expect(mergedOrder(h, ids)).toEqual(["ENG-1"]);

    h.state.mergeReadUnknown = false;
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(getConfirmedRemoteMerge(h.db, "ENG-1")).not.toBeNull();
    expect(await lock(h)).toBeNull();

    let step = await h.pass("ENG-2");
    for (let pass = 0; pass < 4 && step.kind === "wait"; pass++) step = await h.pass("ENG-2");
    expect(step).toEqual({ kind: "merged" });
    expect(mergedOrder(h, ids)).toEqual(["ENG-1", "ENG-2"]);
    await h.git(
      h.bare,
      "merge-base",
      "--is-ancestor",
      "refs/heads/main",
      await h.remoteHead("ENG-2"),
    );
  });

  test("a squash whose unconfirmed outcome turns out unmerged releases the lock", async () => {
    const h = await start({ settings: { order: "ci-green" } });
    await h.addItem("ENG-1");
    h.state.dropMergeResponse = true;
    h.state.mergeReadUnknown = true;
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "merge_outcome" });
    expect(await lock(h)).toMatchObject({ itemId: "ENG-1" });
    h.state.dropMergeResponse = false;
    h.state.mergeReadUnknown = false;
    h.state.handMerged.clear();
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(mergeCallInFlight(h.db, "ENG-1")).toBe(false);
    expect(await lock(h)).toBeNull();
  });

  test("an unconfirmed squash's lock is taken over once its outcome hold expires", async () => {
    const h = await start({ settings: { order: "ci-green" } });
    await h.addItem("ENG-1");
    h.state.mergeResponseStatus = 502;
    h.state.mergeReadUnknown = true;
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "merge_outcome" });
    h.clock.advance(SQUASH_LOCK_OUTCOME_TTL_MS);
    expect(await holdLock(h, "acme/app")).toBe(true);
    expect(await lock(h)).toMatchObject({ itemId: "ENG-99" });
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "merge_outcome" });
    expect(await lock(h)).toMatchObject({ itemId: "ENG-99" });
  });

  test("a lane whose lock was taken over before the squash call does not squash", async () => {
    const h = await start({ settings: { order: "ci-green" } });
    await h.addItem("ENG-1");
    let takenOver = false;
    h.state.beforeMergeToken = (purpose) => {
      if (purpose !== "merge" || takenOver) return;
      h.clock.advance(SQUASH_LOCK_TTL_MS);
      takenOver =
        h.db
          .query(
            "UPDATE repository_merge_lock SET holder = ?, item_id = ?, expires_at = ? WHERE repository = ?",
          )
          .run(
            "other-instance:job-99:turn",
            "ENG-99",
            h.clock.now() + SQUASH_LOCK_TTL_MS,
            "acme/app",
          ).changes === 1;
    };
    expect(await h.pass("ENG-1")).toEqual({
      kind: "wait",
      reason: "repository_lock",
      message: "Another task is merging into acme/app. Merging after it.",
    });
    expect(takenOver).toBe(true);
    expect(h.github.merged).toEqual([]);
    expect(mergeCallInFlight(h.db, "ENG-1")).toBe(false);
    expect(await lock(h)).toMatchObject({ holder: "other-instance:job-99:turn", itemId: "ENG-99" });
  });

  test("a lock on another repository does not hold the squash", async () => {
    const h = await start();
    await h.addItem("ENG-1");
    expect(await holdLock(h, "acme/api")).toBe(true);
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.state.lockSleeps).toEqual([]);
    expect(await lock(h, "acme/api")).toMatchObject({ holder: "other-instance:job-99:turn" });
  });

  test("handing the pull request to GitHub's merge queue does not take the lock", async () => {
    let head = async (): Promise<string> => "";
    const queue = createFakeMergeQueue({ ahead: 1, headOf: () => head() });
    const h = await start({ settings: { order: "github-queue" }, queue });
    await h.addItem("ENG-1");
    head = () => h.remoteHead("ENG-1");
    expect(await holdLock(h, "acme/app")).toBe(true);
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "ahead" });
    expect(queue.enqueued).toHaveLength(1);
    expect(h.state.lockSleeps).toEqual([]);
  });

  test("a lane waiting for the lock parks for a short retry and keeps its CI deadline", async () => {
    const h = await start();
    const store = sqliteDb(h.db);
    enqueueJob(h.db, {
      queue: JOB_KIND.merge,
      payload: { itemId: "ENG-1", ciWaitDeadline: h.clock.now() + 60_000 },
      now: h.clock.now(),
    });
    const job = claimNextJob(h.db, { now: h.clock.now() })!;
    expect(
      await parkMerge(store, job, h.clock.now(), {
        reason: "repository_lock",
        message: "Another task is merging into acme/app. Merging after it.",
      }),
    ).toBe("parked");
    const parked = getJob(h.db, job.id)!;
    expect(parked.runAt).toBe(h.clock.now() + SQUASH_LOCK_RETRY_MS);
    expect(parked.payload).toMatchObject({
      ciWaitDeadline: h.clock.now() + 60_000,
      mergeWait: { reason: "repository_lock" },
    });
  });
});
