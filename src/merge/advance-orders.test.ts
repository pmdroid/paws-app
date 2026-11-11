import { afterEach, describe, expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  resetOtherLaneCiFailures,
  applyWorkItemEvent,
  claimNextJob,
  enqueueJob,
  getConfirmedRemoteMerge,
  getJob,
  getWorkItem,
  joinMergeQueue,
  listCiReruns,
  listCiRounds,
  listJobs,
  listMergeQueues,
  listRebaseReturns,
  listReviewEscapes,
  pendingPullCiFailures,
  rebaseReturnedFor,
  recordCiRerun,
  recordRebaseReturn,
  saveWorkItemLinearProject,
  sqliteDb,
} from "../db";
import { createFakeMergeQueue } from "../github";
import { findOpenQuestion } from "../questions";
import {
  LOG_TAIL,
  failingTest,
  mergeHarness,
  pendingCi,
  type MergeHarness,
} from "./advance-harness";
import { REBASE_CONFLICT_INSTRUCTION } from "./orders";

let harness: MergeHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

async function start(settings: Parameters<typeof mergeHarness>[0] = {}) {
  harness = await mergeHarness(settings);
  return harness;
}

async function resumes(h: MergeHarness) {
  return (await listJobs(sqliteDb(h.db)))
    .filter((job) => job.queue === JOB_KIND.resume)
    .map((job) => job.payload as { itemId: string; handoff: string; reason: string });
}

function mergedOrder(h: MergeHarness, ids: string[]): string[] {
  return h.github.merged.map((merge) => ids[merge.number - 1]!);
}

/** Lane passes until the task merges: a branch behind main is updated first, then merges. */
async function passUntilMerged(h: MergeHarness, id: string) {
  let step = await h.pass(id);
  for (let pass = 0; pass < 3 && step.kind === "wait" && step.reason === "ci"; pass++)
    step = await h.pass(id);
  return step;
}

async function queued(h: MergeHarness): Promise<string[]> {
  return (await listMergeQueues(sqliteDb(h.db))).map((entry) => entry.itemId);
}

describe("advanceMerge in the repository merge queue", () => {
  test("ready tasks merge one at a time in the order they joined, and hear each place once", async () => {
    const h = await start({ settings: { order: "queue" } });
    const ids = ["ENG-103", "ENG-101", "ENG-102"];
    for (const id of ids) await h.addItem(id);
    h.state.ci = pendingCi;
    for (const id of ids) {
      await h.pass(id);
      h.clock.advance(1_000);
    }
    expect(await queued(h)).toEqual(ids);
    expect(await h.pass("ENG-101")).toMatchObject({
      kind: "wait",
      reason: "ahead",
      queued: true,
      message: "Second in the acme/app queue. ENG-103 merges first.",
    });
    expect(await h.pass("ENG-103")).toMatchObject({ kind: "wait", reason: "ci" });
    expect(h.github.merged).toEqual([]);

    h.state.ci = () => undefined;
    expect(await h.pass("ENG-101")).toMatchObject({ kind: "wait", reason: "ahead" });
    expect(await h.pass("ENG-103")).toEqual({ kind: "merged" });
    expect(await h.pass("ENG-101")).toEqual({ kind: "merged" });
    expect(await h.pass("ENG-102")).toEqual({ kind: "merged" });
    expect(mergedOrder(h, ids)).toEqual(ids);
    expect(await queued(h)).toEqual([]);
    expect(h.bodies("status").filter((body) => body.includes("acme/app queue"))).toEqual([
      "Second in the acme/app queue. ENG-103 merges first.",
      "Third in the acme/app queue. ENG-101 merges first.",
      "First in the acme/app queue. Merging next.",
      "First in the acme/app queue. Merging next.",
    ]);
  });

  test("a task waiting for a review holds no place, and a ci-green task merges on its own", async () => {
    const h = await start({ settings: { order: "queue" } });
    const ids = ["ENG-111", "ENG-112", "ENG-113", "ENG-114"];
    const items = [];
    for (const id of ids) items.push(await h.addItem(id));
    h.state.orders.set("ENG-114", "ci-green");
    h.state.reviews.set(3, "REVIEW_REQUIRED");
    const hotfix = items[3]!.accepted;
    h.state.ci = (head) => (head === hotfix ? undefined : pendingCi());
    for (const id of ids) {
      await h.pass(id);
      h.clock.advance(1_000);
    }
    expect(await queued(h)).toEqual(["ENG-111", "ENG-112"]);
    expect(mergedOrder(h, ids)).toEqual(["ENG-114"]);
    expect(h.bodies("afterPullRequest")).toEqual([
      "Waiting for an approving review on [pull request #3](https://github.com/acme/app/pull/3). It joins the acme/app merge queue once approved.",
    ]);

    h.state.ci = () => undefined;
    expect(await h.pass("ENG-111")).toEqual({ kind: "merged" });
    expect(await h.pass("ENG-112")).toEqual({ kind: "merged" });
    expect(await h.pass("ENG-113")).toMatchObject({ kind: "wait", reason: "review" });
    h.state.reviews.set(3, "APPROVED");
    expect(await h.pass("ENG-113")).toEqual({ kind: "merged" });
    expect(mergedOrder(h, ids)).toEqual(["ENG-114", "ENG-111", "ENG-112", "ENG-113"]);
  });

  test("a CI failure at the front goes back to the agent, wakes the task behind, and the fix rejoins at the end", async () => {
    const h = await start({ settings: { order: "queue" } });
    const ids = ["ENG-121", "ENG-122", "ENG-123"];
    const items = [];
    for (const id of ids) items.push(await h.addItem(id));
    h.state.ci = pendingCi;
    for (const id of ids) {
      await h.pass(id);
      h.clock.advance(1_000);
    }
    const behind = await enqueueJob(sqliteDb(h.db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "ENG-122", mergeWait: { reason: "ahead" } },
      runAt: h.clock.now() + 300_000,
      now: h.clock.now(),
    });

    const review = await enqueueJob(sqliteDb(h.db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "ENG-124", mergeWait: { reason: "review" } },
      runAt: h.clock.now() + 300_000,
      now: h.clock.now(),
    });

    const failing = items[0]!.accepted;
    h.state.ci = (head) => (head === failing ? failingTest() : undefined);
    expect(await h.pass("ENG-121")).toEqual({ kind: "returned" });
    expect((await getJob(sqliteDb(h.db), behind))?.runAt).toBe(h.clock.now());
    expect((await getJob(sqliteDb(h.db), review))?.runAt).toBe(h.clock.now() + 300_000);
    expect((await resumes(h)).map((payload) => [payload.itemId, payload.reason])).toEqual([
      ["ENG-121", "ci"],
    ]);
    expect(await queued(h)).toEqual(["ENG-122", "ENG-123"]);

    expect(await h.pass("ENG-122")).toEqual({ kind: "merged" });
    await h.requeue("ENG-121", "fixed\n");
    h.clock.advance(1_000);
    expect(await h.pass("ENG-121")).toMatchObject({ kind: "wait", reason: "ahead" });
    expect(await queued(h)).toEqual(["ENG-123", "ENG-121"]);
    expect(await h.pass("ENG-123")).toEqual({ kind: "merged" });
    expect(await h.pass("ENG-121")).toEqual({ kind: "merged" });
    expect(mergedOrder(h, ids)).toEqual(["ENG-122", "ENG-123", "ENG-121"]);
  });

  test("a re-verifying task keeps its place without holding the lane, and merges next once accepted", async () => {
    const h = await start({ settings: { order: "queue", mainMoved: "ci" } });
    const ids = ["ENG-141", "ENG-142", "ENG-143", "ENG-144"];
    for (const id of ids) await h.addItem(id);
    h.state.ci = pendingCi;
    for (const id of ids) {
      await h.pass(id);
      h.clock.advance(1_000);
    }
    await applyWorkItemEvent(sqliteDb(h.db), "ENG-141", "reverify_requested");
    expect(
      (await listMergeQueues(sqliteDb(h.db))).map((entry) => [
        entry.itemId,
        entry.position,
        entry.busy,
      ]),
    ).toEqual([
      ["ENG-141", 1, true],
      ["ENG-142", 2, false],
      ["ENG-143", 3, false],
      ["ENG-144", 4, false],
    ]);

    h.state.ci = () => undefined;
    expect(await h.pass("ENG-143")).toMatchObject({
      kind: "wait",
      reason: "ahead",
      message: "Third in the acme/app queue. ENG-142 merges first.",
    });
    expect(await h.pass("ENG-142")).toEqual({ kind: "merged" });
    expect(await passUntilMerged(h, "ENG-143")).toEqual({ kind: "merged" });
    expect(await queued(h)).toEqual(["ENG-141", "ENG-144"]);

    await h.closeout("ENG-141");
    expect(await h.pass("ENG-144")).toMatchObject({
      kind: "wait",
      reason: "ahead",
      message: "Second in the acme/app queue. ENG-141 merges first.",
    });
    expect(await passUntilMerged(h, "ENG-141")).toEqual({ kind: "merged" });
    expect(await passUntilMerged(h, "ENG-144")).toEqual({ kind: "merged" });
    expect(mergedOrder(h, ids)).toEqual(["ENG-142", "ENG-143", "ENG-141", "ENG-144"]);
  });

  test("a policy digest change alone leaves every waiting task accepted and in its place", async () => {
    const h = await start({ settings: { order: "queue" } });
    const ids = ["ENG-161", "ENG-162", "ENG-163"];
    for (const id of ids) await h.addItem(id);
    h.state.ci = pendingCi;
    for (const id of ids) {
      await h.pass(id);
      h.clock.advance(1_000);
    }
    h.state.policyDigest = "sha256:changed-policy";
    for (const id of ids.toReversed()) expect(await h.pass(id)).toMatchObject({ kind: "wait" });
    expect(
      await Promise.all(ids.map(async (id) => (await getWorkItem(sqliteDb(h.db), id))?.state)),
    ).toEqual(ids.map(() => "merge_queue"));
    expect(
      (await listJobs(sqliteDb(h.db))).filter((job) => job.queue === JOB_KIND.reverify),
    ).toEqual([]);
    h.state.ci = () => undefined;
    // The front merges on the acceptance it already had; nothing ran through Closeout again.
    expect(await passUntilMerged(h, "ENG-161")).toEqual({ kind: "merged" });
    expect(mergedOrder(h, ids)).toEqual(["ENG-161"]);
    expect(h.verified).toEqual([]);
  });

  test("a `recheck: true` check change re-verifies every waiting task at once, each keeping its place", async () => {
    const h = await start({ settings: { order: "queue" } });
    const ids = ["ENG-151", "ENG-152", "ENG-153", "ENG-154", "ENG-155"];
    for (const id of ids) await h.addItem(id);
    h.state.ci = pendingCi;
    for (const id of ids) {
      await h.pass(id);
      h.clock.advance(1_000);
    }
    h.state.policyDigest = "sha256:changed-policy";
    h.state.recheckDigest = "sha256:changed-recheck";
    // Behind the front, each waiting task sends itself to Closeout without waiting for its turn.
    for (const id of ids.toReversed()) expect(await h.pass(id)).toEqual({ kind: "returned" });
    expect(
      await Promise.all(ids.map(async (id) => (await getWorkItem(sqliteDb(h.db), id))?.state)),
    ).toEqual(ids.map(() => "verifying"));
    const reverify = (await listJobs(sqliteDb(h.db))).filter(
      (job) => job.queue === JOB_KIND.reverify,
    );
    expect(reverify.map((job) => (job.payload as { itemId: string }).itemId).toSorted()).toEqual(
      ids,
    );
    expect(new Set(reverify.map((job) => job.status))).toEqual(new Set(["pending"]));
    expect(new Set(reverify.map((job) => job.runAt))).toEqual(new Set([h.clock.now()]));
    expect(
      (await listMergeQueues(sqliteDb(h.db))).map((entry) => [entry.itemId, entry.busy]),
    ).toEqual(ids.map((id) => [id, true]));
    expect(h.github.merged).toEqual([]);
    // The five Closeout re-runs are claimed side by side, not one after another.
    const running = [];
    for (const _ of ids)
      running.push(
        await claimNextJob(sqliteDb(h.db), { queues: [JOB_KIND.reverify], now: h.clock.now() }),
      );
    expect(
      running.map((job) => (job?.payload as { itemId?: string } | undefined)?.itemId).toSorted(),
    ).toEqual(ids);
  });

  test("a task blocked by the one behind it holds no place: the blocker merges first, then it", async () => {
    const h = await start({ settings: { order: "queue" } });
    const ids = ["ENG-131", "ENG-132"];
    for (const id of ids) await h.addItem(id);
    h.state.blockedBy.set("ENG-131", ["ENG-132"]);
    // ENG-131 joined before Linear's `blocks` relation reached Paws, and keeps its place.
    await joinMergeQueue(sqliteDb(h.db), {
      itemId: "ENG-131",
      repository: "acme/app",
      now: h.clock.now(),
    });
    h.clock.advance(1_000);
    const waiting = await enqueueJob(sqliteDb(h.db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "ENG-131", mergeWait: { reason: "dependencies" } },
      runAt: h.clock.now() + 300_000,
      now: h.clock.now(),
    });

    expect(await h.pass("ENG-131")).toEqual({
      kind: "wait",
      reason: "dependencies",
      queued: true,
      message: "ENG-131: waiting for ENG-132",
    });
    expect(h.bodies("status")).toEqual(["ENG-131: waiting for ENG-132"]);
    expect(await h.pass("ENG-132")).toEqual({ kind: "merged" });
    expect(h.published).toEqual(["ENG-132"]);
    expect((await getJob(sqliteDb(h.db), waiting))?.runAt).toBe(h.clock.now());

    expect(await queued(h)).toEqual(["ENG-131"]);
    expect(await h.pass("ENG-131")).toEqual({ kind: "merged" });
    expect(mergedOrder(h, ids)).toEqual(["ENG-132", "ENG-131"]);
  });

  test("project lanes move independently, and the second lane to merge rebases onto the first's main", async () => {
    const h = await start({ settings: { order: "queue", mainMoved: "ci" } });
    const ids = ["ENG-171", "ENG-172", "ENG-173"];
    for (const id of ids) await h.addItem(id);
    const lanes: Record<string, [string, string]> = {
      "ENG-171": ["project-a", "Billing"],
      "ENG-172": ["project-b", "Search"],
      "ENG-173": ["project-a", "Billing"],
    };
    for (const [id, [lane, name]] of Object.entries(lanes)) {
      h.state.lanes.set(id, lane);
      await saveWorkItemLinearProject(sqliteDb(h.db), id, { id: lane, name });
    }
    h.state.ci = pendingCi;
    for (const id of ids) {
      await h.pass(id);
      h.clock.advance(1_000);
    }
    expect(
      (await listMergeQueues(sqliteDb(h.db))).map((entry) => [
        entry.itemId,
        entry.lane,
        entry.position,
      ]),
    ).toEqual([
      ["ENG-171", "project-a", 1],
      ["ENG-173", "project-a", 2],
      ["ENG-172", "project-b", 1],
    ]);
    expect(h.bodies("status")).toContain(
      "Second in the acme/app queue for Billing. ENG-171 merges first.",
    );

    h.state.ci = () => undefined;
    const accepted = await h.remoteHead("ENG-172");
    expect(await h.pass("ENG-171")).toEqual({ kind: "merged" });
    // The fake records the squash; land it on main as GitHub would.
    await h.moveMain("lane-a.txt", "lane a\n");
    // Lane B's head no longer contains main, so it is not mergeable: it goes through
    // `main_moved = "ci"` (rebase, wait for CI) instead of squashing.
    expect(await h.pass("ENG-172")).toMatchObject({ kind: "wait", reason: "ci" });
    expect(mergedOrder(h, ids)).toEqual(["ENG-171"]);
    const rebased = await h.remoteHead("ENG-172");
    expect(rebased).not.toBe(accepted);
    expect(await h.pass("ENG-172")).toEqual({ kind: "merged" });
    expect(h.github.merged.at(-1)?.expectedHeadSha).toBe(rebased);
    expect(await passUntilMerged(h, "ENG-173")).toEqual({ kind: "merged" });
    expect(mergedOrder(h, ids)).toEqual(["ENG-171", "ENG-172", "ENG-173"]);
  });

  test("a task with no dependencies behind a blocked one merges without waiting", async () => {
    const h = await start({ settings: { order: "queue" } });
    const ids = ["ENG-141", "ENG-142"];
    for (const id of ids) await h.addItem(id);
    h.state.blockedBy.set("ENG-141", ["ENG-140"]);
    await joinMergeQueue(sqliteDb(h.db), {
      itemId: "ENG-141",
      repository: "acme/app",
      now: h.clock.now(),
    });
    h.clock.advance(1_000);

    expect(await h.pass("ENG-141")).toMatchObject({ kind: "wait", reason: "dependencies" });
    expect(await h.pass("ENG-142")).toEqual({ kind: "merged" });
    expect(await h.pass("ENG-141")).toMatchObject({ kind: "wait", reason: "dependencies" });
    expect(h.published).toEqual(["ENG-142"]);
    expect(mergedOrder(h, ids)).toEqual(["ENG-142"]);
    // ENG-141 keeps its row, so its place comes back when ENG-140 merges.
    expect(await queued(h)).toEqual(["ENG-141"]);
  });
});

describe("advanceMerge on failed CI while a review is required", () => {
  const feedbackJobs = async (h: MergeHarness) =>
    (await listJobs(sqliteDb(h.db))).filter((job) => job.queue === JOB_KIND.pullComments);

  test("the review gate records the failure once and sends nothing back before the batch", async () => {
    const h = await start({ settings: { order: "queue" } });
    const item = await h.addItem("ENG-131");
    h.state.reviews.set(item.pull, "REVIEW_REQUIRED");
    h.state.ci = failingTest;
    const observed = h.clock.now();
    expect(await h.pass("ENG-131")).toMatchObject({ kind: "wait", reason: "review" });
    expect(h.state.ciReads).toEqual([item.accepted]);
    const [failure] = await pendingPullCiFailures(sqliteDb(h.db), "ENG-131");
    expect(failure).toMatchObject({
      head: item.accepted,
      pullNumber: item.pull,
      observedAt: observed,
    });
    expect(failure?.failedChecks).toEqual([
      { name: "test", url: "https://ci.example/1", failsOnBase: false, logTail: LOG_TAIL },
    ]);
    expect((await feedbackJobs(h)).map((job) => job.runAt)).toEqual([observed + 60_000]);

    h.clock.advance(20_000);
    expect(await h.pass("ENG-131")).toMatchObject({ kind: "wait", reason: "review" });
    expect((await pendingPullCiFailures(sqliteDb(h.db), "ENG-131"))[0]?.observedAt).toBe(observed);
    expect((await feedbackJobs(h)).map((job) => job.runAt)).toEqual([observed + 60_000]);
    expect(await resumes(h)).toEqual([]);
    expect(await listCiRounds(sqliteDb(h.db), "ENG-131")).toEqual([]);
    expect((await getWorkItem(sqliteDb(h.db), "ENG-131"))?.state).toBe("merge_queue");
    expect(h.github.merged).toEqual([]);
  });

  test("approval during the batch does not merge; green CI on the same head then merges it", async () => {
    const h = await start({ settings: { order: "queue" } });
    const item = await h.addItem("ENG-132");
    h.state.reviews.set(item.pull, "REVIEW_REQUIRED");
    h.state.ci = failingTest;
    await h.pass("ENG-132");
    h.state.reviews.set(item.pull, "APPROVED");
    expect(await h.pass("ENG-132")).toMatchObject({ kind: "wait", reason: "review" });
    expect(h.github.merged).toEqual([]);
    expect(await resumes(h)).toEqual([]);

    h.state.ci = () => undefined;
    expect(await h.pass("ENG-132")).toEqual({ kind: "merged" });
    expect(await pendingPullCiFailures(sqliteDb(h.db), "ENG-132")).toEqual([]);
    expect(h.github.merged.map((merge) => merge.expectedHeadSha)).toEqual([item.accepted]);
    expect(await listCiRounds(sqliteDb(h.db), "ENG-132")).toEqual([]);
  });

  test("pending or green CI waits for the review and records nothing; a moved head drops the failure", async () => {
    const h = await start({ settings: { order: "queue" } });
    const item = await h.addItem("ENG-133");
    h.state.reviews.set(item.pull, "CHANGES_REQUESTED");
    h.state.ci = pendingCi;
    expect(await h.pass("ENG-133")).toMatchObject({ kind: "wait", reason: "review" });
    h.state.ci = () => undefined;
    expect(await h.pass("ENG-133")).toMatchObject({ kind: "wait", reason: "review" });
    expect(await pendingPullCiFailures(sqliteDb(h.db), "ENG-133")).toEqual([]);
    expect(await feedbackJobs(h)).toEqual([]);

    h.state.ci = failingTest;
    await h.pass("ENG-133");
    expect(
      (await pendingPullCiFailures(sqliteDb(h.db), "ENG-133")).map((failure) => failure.head),
    ).toEqual([item.accepted]);
    h.state.pullHead = () => "0".repeat(40);
    expect(await h.pass("ENG-133")).toMatchObject({ kind: "wait", reason: "review" });
    expect(await pendingPullCiFailures(sqliteDb(h.db), "ENG-133")).toEqual([]);
    expect(await resumes(h)).toEqual([]);
    expect(await listCiRounds(sqliteDb(h.db), "ENG-133")).toEqual([]);
  });
});

describe("advanceMerge on a CI failure", () => {
  test("a failing check goes back to the agent with the end of its log, and the round is recorded", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    h.state.ci = failingTest;
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect((await getWorkItem(sqliteDb(h.db), "ENG-1"))?.state).toBe("queued");
    const [resume] = await resumes(h);
    expect(resume?.reason).toBe("ci");
    expect(resume?.handoff).toContain(`End of the \`test\` log:\n\`\`\`\n${LOG_TAIL}\n\`\`\``);
    expect(h.bodies("status")).toContain("CI: `test` failed. Sent back to the agent, fix 1 of 3.");
    const rounds = await listCiRounds(sqliteDb(h.db), "ENG-1");
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ head: item.accepted, next: "agent", fix: 1, fixLimit: 3 });
    expect(rounds[0]?.runId).not.toBeNull();
    expect(rounds[0]?.checks.map((check) => [check.name, check.state])).toEqual([
      ["lint", "passed"],
      ["test", "failed"],
      ["e2e", "passed"],
    ]);
    expect(rounds[0]?.checks[1]).toMatchObject({
      url: "https://ci.example/1",
      logSource: "actions",
      logTail: LOG_TAIL,
    });
  });

  test("CI failing on the accepted head is one candidate review escape per fix round", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    h.state.ci = failingTest;
    h.state.baseCi = () => [{ name: "e2e", conclusion: "FAILURE", detailsUrl: null }];
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(await listReviewEscapes(sqliteDb(h.db))).toEqual([
      expect.objectContaining({
        itemId: "ENG-1",
        trigger: "ci",
        acceptedHead: item.accepted,
        pullNumber: item.pull,
        detail: { checks: [{ name: "test", failsOnBase: false }] },
      }),
    ]);

    // The fix fails again, now on a check that also fails on main.
    const fix = await h.requeue("ENG-1", "fix 1\n");
    h.state.ci = () => [{ name: "e2e", conclusion: "FAILURE", detailsUrl: null }];
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(
      (await listReviewEscapes(sqliteDb(h.db))).map((row) => [row.acceptedHead, row.detail.checks]),
    ).toEqual([
      [item.accepted, [{ name: "test", failsOnBase: false }]],
      [fix, [{ name: "e2e", failsOnBase: true }]],
    ]);
  });

  test("when the CI fix attempts run out, Paws asks in Linear instead of failing", async () => {
    const h = await start();
    await h.addItem("ENG-1");
    h.state.ciFixAttempts = 1;
    h.state.ci = failingTest;
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    await h.requeue("ENG-1", "fix 1\n");
    expect(await h.pass("ENG-1")).toEqual({ kind: "asked" });
    expect((await getWorkItem(sqliteDb(h.db), "ENG-1"))?.state).toBe("awaiting_input");
    const question = (await findOpenQuestion(sqliteDb(h.db), "ses-ENG-1"))!;
    expect(question.body).toContain(
      "The agent used all 1 fix round across Closeout, CI and review.",
    );
    expect(question.body).toContain("- test (https://ci.example/1)");
    const rounds = await listCiRounds(sqliteDb(h.db), "ENG-1");
    expect(rounds.map((round) => [round.next, round.fix, round.fixLimit])).toEqual([
      ["agent", 1, 1],
      ["asked", null, 1],
    ]);
    expect(new Set(rounds.map((round) => round.head)).size).toBe(2);
    expect(await resumes(h)).toHaveLength(1);
  });

  test("with CI fix attempts set to 0, Paws asks on the first failure", async () => {
    const h = await start();
    await h.addItem("ENG-1");
    h.state.ciFixAttempts = 0;
    h.state.ci = failingTest;
    expect(await h.pass("ENG-1")).toEqual({ kind: "asked" });
    expect((await findOpenQuestion(sqliteDb(h.db), "ses-ENG-1"))?.body).toContain(
      "Fix rounds are set to 0",
    );
    expect(await resumes(h)).toEqual([]);
  });

  test("a changed CI fix setting applies to the next CI round of a running task", async () => {
    const h = await start();
    await h.addItem("ENG-1");
    h.state.ci = failingTest;
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(h.bodies("status")).toContain("CI: `test` failed. Sent back to the agent, fix 1 of 3.");
    h.state.ciFixAttempts = 1;
    await h.requeue("ENG-1", "fix 1\n");
    expect(await h.pass("ENG-1")).toEqual({ kind: "asked" });
    expect((await findOpenQuestion(sqliteDb(h.db), "ses-ENG-1"))?.body).toContain(
      "The agent used all 1 fix round across Closeout, CI and review.",
    );
  });
});

function cancelledShard(
  conclusion = "CANCELLED",
  shard2 = "SUCCESS",
): ReturnType<typeof failingTest> {
  const job = (
    name: string,
    result: string,
    id: number,
    startedAt: string,
    completedAt: string,
  ) => ({
    name,
    conclusion: result,
    detailsUrl: `https://github.com/acme/app/actions/runs/900/job/${id}`,
    startedAt,
    completedAt,
    checkSuite: { app: { slug: "github-actions" } },
  });
  return [
    job("test (1/4)", conclusion, 1, "2026-11-04T22:21:00Z", "2026-11-04T22:33:00Z"),
    job("test (2/4)", shard2, 2, "2026-11-04T22:21:00Z", "2026-11-04T22:27:00Z"),
    job(
      "lint, format, types, test, dashboard build",
      "FAILURE",
      5,
      "2026-11-04T22:33:10Z",
      "2026-11-04T22:33:20Z",
    ),
  ];
}

describe("advanceMerge on cancelled CI jobs", () => {
  for (const conclusion of ["CANCELLED", "TIMED_OUT"])
    test(`a ${conclusion.toLowerCase()} shard and the aggregate job it fails are re-run once, then the head merges with no agent turn`, async () => {
      const h = await start();
      const item = await h.addItem("ENG-1");
      h.state.ci = () => cancelledShard(conclusion);
      expect(await h.pass("ENG-1")).toMatchObject({
        kind: "wait",
        reason: "ci",
        head: item.accepted,
      });
      expect(h.state.ciReruns).toEqual(["/repos/acme/app/actions/runs/900/rerun-failed-jobs"]);
      expect(await listCiReruns(sqliteDb(h.db), "ENG-1")).toMatchObject([
        { head: item.accepted, runIds: [900], reason: "cancelled or timed-out CI job" },
      ]);
      expect(h.bodies("status")).toContain(
        `Re-ran cancelled CI jobs on ${item.accepted.slice(0, 7)}.`,
      );
      expect((await getWorkItem(sqliteDb(h.db), "ENG-1"))?.state).toBe("merge_queue");
      expect(await resumes(h)).toEqual([]);
      expect(await listCiRounds(sqliteDb(h.db), "ENG-1")).toEqual([]);

      h.state.ci = () => undefined;
      expect(await passUntilMerged(h, "ENG-1")).toEqual({ kind: "merged" });
      expect(await resumes(h)).toEqual([]);
    });

  test("a re-run cancelled again goes back to the agent as today", async () => {
    const h = await start();
    await h.addItem("ENG-1");
    h.state.ci = () => cancelledShard();
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "ci" });
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(h.state.ciReruns).toHaveLength(1);
    expect((await resumes(h)).map((resume) => resume.reason)).toEqual(["ci"]);
    expect(h.bodies("status")).toContain(
      "CI: `test (1/4)`, `lint, format, types, test, dashboard build` failed. Sent back to the agent, fix 1 of 3.",
    );
  });

  test("a cancelled shard beside a real test failure goes back to the agent with no re-run", async () => {
    const h = await start();
    await h.addItem("ENG-1");
    h.state.ci = () => cancelledShard("CANCELLED", "FAILURE");
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(h.state.ciReruns).toEqual([]);
    expect(await listCiReruns(sqliteDb(h.db), "ENG-1")).toEqual([]);
  });

  test("a head already re-run is not re-run again", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    await recordCiRerun(sqliteDb(h.db), {
      itemId: "ENG-1",
      head: item.accepted,
      runIds: [899],
      reason: "flaky",
      at: 1,
    });
    h.state.ci = () => cancelledShard();
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(h.state.ciReruns).toEqual([]);
  });
});

describe("advanceMerge with the GitHub merge queue order", () => {
  async function githubQueue(branches?: string[]) {
    let head = async (): Promise<string> => "";
    const queue = createFakeMergeQueue({
      ...(branches ? { branches } : {}),
      ahead: 1,
      headOf: () => head(),
    });
    const h = await start({ settings: { order: "github-queue" }, queue });
    await h.addItem("ENG-1");
    head = () => h.remoteHead("ENG-1");
    return { h, queue };
  }

  test("Paws queues the accepted pull request, follows its place, and GitHub merges it", async () => {
    const { h, queue } = await githubQueue();
    const queuedLine = "Second in the acme/app GitHub merge queue, queued.";
    const movedLine = "First in the acme/app GitHub merge queue, waiting for checks.";
    expect(await h.pass("ENG-1")).toMatchObject({
      kind: "wait",
      reason: "ahead",
      githubQueue: { queued: true, line: queuedLine },
    });
    queue.move(1, 1, "AWAITING_CHECKS");
    expect(await h.pass("ENG-1")).toMatchObject({
      kind: "wait",
      reason: "ci",
      githubQueue: { queued: true, line: movedLine },
    });
    queue.merge(1, "queue-merge-sha");
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(queue.enqueued).toHaveLength(1);
    expect(h.github.merged).toEqual([]);
    expect((await getConfirmedRemoteMerge(sqliteDb(h.db), "ENG-1"))?.mergeSha).toBe(
      "queue-merge-sha",
    );
    expect(h.bodies("status")).toEqual([
      `Added https://github.com/acme/app/pull/1 to the GitHub merge queue. ${queuedLine}`,
      movedLine,
    ]);
  });

  test("a removal for a failing check goes back to the agent, and the fix is queued again", async () => {
    const { h, queue } = await githubQueue();
    await h.pass("ENG-1");
    queue.remove(1, "FAILED_CHECKS");
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    const [resume] = await resumes(h);
    expect(resume?.reason).toBe("ci");
    expect(resume?.handoff).toContain("GitHub's merge queue removed the pull request");
    expect(h.bodies("status")).toContain(
      "CI: `FAILED_CHECKS` failed. Sent back to the agent, fix 1 of 3.",
    );
    await h.requeue("ENG-1", "fix 1\n");
    await h.pass("ENG-1");
    expect(queue.enqueued).toHaveLength(2);
    queue.merge(1);
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.github.merged).toEqual([]);
  });

  test("a GitHub queue conflict asks once the rebase budget is spent", async () => {
    const { h, queue } = await githubQueue();
    for (let round = 0; round < 3; round++) {
      await h.pass("ENG-1");
      queue.remove(1, "MERGE_CONFLICT");
      expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
      await h.requeue("ENG-1", `resolve ${round}\n`);
    }
    await h.pass("ENG-1");
    queue.remove(1, "MERGE_CONFLICT");
    expect(await h.pass("ENG-1")).toEqual({ kind: "asked" });
    expect(await findOpenQuestion(sqliteDb(h.db), "ses-ENG-1")).toMatchObject({
      reason: "rebase_budget_spent",
    });
    expect((await getWorkItem(sqliteDb(h.db), "ENG-1"))?.state).toBe("awaiting_input");
  });

  test("a person removing the pull request from the queue makes Paws ask in Linear", async () => {
    const { h, queue } = await githubQueue();
    await h.pass("ENG-1");
    queue.remove(1, "MANUAL", "octocat");
    expect(await h.pass("ENG-1")).toEqual({ kind: "asked" });
    expect((await getWorkItem(sqliteDb(h.db), "ENG-1"))?.state).toBe("awaiting_input");
    const body = (await findOpenQuestion(sqliteDb(h.db), "ses-ENG-1"))?.body ?? "";
    expect(body).toContain("@octocat removed");
    expect(body).toContain("from the acme/app GitHub merge queue (MANUAL).");
    expect(body).toContain("What should Paws do?");
  });

  test("without a merge queue on main, Paws merges the pull request itself", async () => {
    const { h, queue } = await githubQueue([]);
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(queue.enqueued).toEqual([]);
    expect(h.github.merged).toHaveLength(1);
    expect(h.bodies("status")).toContain(
      "main in acme/app has no GitHub merge queue. Paws merges the pull request itself when its CI is green.",
    );
  });
});

describe("advanceMerge while the pull request waits for a review", () => {
  const NOTICE =
    "Waiting for an approving review on [pull request #1](https://github.com/acme/app/pull/1). It joins the acme/app merge queue once approved.";

  async function waiting() {
    const h = await start({ settings: { order: "queue" } });
    await h.addItem("ENG-1", { file: "ok.txt", content: "agent\n" });
    h.state.reviews.set(1, "REVIEW_REQUIRED");
    return h;
  }

  test("a conflicting pull request goes back to rebase without waiting for the approval", async () => {
    const h = await waiting();
    const main = await h.moveMain("ok.txt", "from-main\n");
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect((await resumes(h)).map((payload) => [payload.reason, payload.handoff])).toEqual([
      ["conflict", REBASE_CONFLICT_INSTRUCTION],
    ]);
    expect(await listRebaseReturns(sqliteDb(h.db), "ENG-1", 0)).toMatchObject([
      { base: main, reason: "merge" },
    ]);
    expect(await rebaseReturnedFor(sqliteDb(h.db), "ENG-1", await h.remoteHead("ENG-1"))).toBe(
      true,
    );
    expect(h.bodies("afterPullRequest")).toEqual([]);
  });

  test("a clean pull request keeps waiting for the review", async () => {
    const h = await waiting();
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "review" });
    expect(await resumes(h)).toEqual([]);
    expect(h.bodies("afterPullRequest")).toEqual([NOTICE]);
  });

  test("a mergeable GitHub never computes keeps waiting for the review", async () => {
    const h = await waiting();
    await h.moveMain("ok.txt", "from-main\n");
    h.state.lazyMergeable.set(1, 100);
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "review" });
    expect(h.state.pullReads.get(1)).toBe(4);
    expect(await resumes(h)).toEqual([]);
    expect(h.bodies("afterPullRequest")).toEqual([NOTICE]);
  });

  test("with the rebase budget spent Paws asks instead of sending it back", async () => {
    const h = await waiting();
    const main = await h.moveMain("ok.txt", "from-main\n");
    for (let spent = 0; spent < 3; spent++)
      await recordRebaseReturn(sqliteDb(h.db), {
        itemId: "ENG-1",
        jobId: 900 + spent,
        candidate: `earlier-${spent}`,
        reason: "merge",
        base: main,
        files: null,
        recordedAt: h.clock.now(),
      });
    expect(await h.pass("ENG-1")).toEqual({ kind: "asked" });
    expect(await findOpenQuestion(sqliteDb(h.db), "ses-ENG-1")).toMatchObject({
      reason: "rebase_budget_spent",
    });
    expect((await getWorkItem(sqliteDb(h.db), "ENG-1"))?.state).toBe("awaiting_input");
    expect(await resumes(h)).toEqual([]);
    expect(h.bodies("afterPullRequest")).toEqual([]);
  });

  test("a pull request that starts conflicting while it waits goes back on the next turn", async () => {
    const h = await waiting();
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait", reason: "review" });
    await h.moveMain("ok.txt", "from-main\n");
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect((await resumes(h)).map((payload) => payload.handoff)).toEqual([
      REBASE_CONFLICT_INSTRUCTION,
    ]);
    expect(h.bodies("afterPullRequest")).toEqual([NOTICE]);
  });
});

describe("CI failure collection window", () => {
  for (const finish of ["FAILURE", "SUCCESS", null]) {
    test(`acme waits for all checks: ${finish ?? "20 minute cap"}`, async () => {
      const h = await start();
      await h.addItem("ACME-1440");
      let conclusion: string | null = null;
      h.state.ci = () => [
        { name: "acme test", conclusion: "FAILURE", detailsUrl: "https://ci.example/test" },
        { name: "acme shard", conclusion, detailsUrl: "https://ci.example/shard" },
      ];
      expect(await h.pass("ACME-1440")).toMatchObject({
        kind: "wait",
        reason: "ci",
        message: "CI failed: acme test; waiting for acme shard to finish (up to 20 min)",
      });
      expect(await resumes(h)).toEqual([]);
      h.clock.advance(19 * 60_000);
      expect(await h.pass("ACME-1440")).toMatchObject({ kind: "wait", reason: "ci" });
      expect(await resumes(h)).toEqual([]);
      conclusion = finish;
      if (finish === null) h.clock.advance(60_000);
      expect(await h.pass("ACME-1440")).toEqual({ kind: "returned" });
      const turns = await resumes(h);
      expect(turns).toHaveLength(1);
      expect(turns[0]!.handoff).toContain("acme test");
      if (finish === "FAILURE") expect(turns[0]!.handoff).toContain("- acme shard");
      if (finish === "SUCCESS") expect(turns[0]!.handoff).not.toContain("acme shard");
      if (finish === null)
        expect(turns[0]!.handoff).toContain("acme shard (https://ci.example/shard): still running");
    });
  }
});

test("acme head movement starts a fresh CI collection window", async () => {
  const h = await start();
  const item = await h.addItem("ACME-1441");
  h.state.ci = () => [
    { name: "acme test", conclusion: "FAILURE", detailsUrl: null },
    { name: "acme shard", conclusion: null, detailsUrl: null },
  ];
  expect(await h.pass("ACME-1441")).toMatchObject({ kind: "wait", reason: "ci" });
  h.clock.advance(19 * 60_000);
  await resetOtherLaneCiFailures(sqliteDb(h.db), "ACME-1441", "another-head");
  // Returning to the original head must also start a new window.
  expect(await h.pass("ACME-1441")).toMatchObject({ kind: "wait", head: item.accepted });
  h.clock.advance(60_000);
  expect(await h.pass("ACME-1441")).toMatchObject({ kind: "wait", reason: "ci" });
  expect(await resumes(h)).toEqual([]);
});

describe("CI collection across merge paths", () => {
  const checks = (shard: string | null) => [
    { name: "acme test", conclusion: "FAILURE", detailsUrl: "https://ci.example/test" },
    { name: "acme shard", conclusion: shard, detailsUrl: "https://ci.example/shard" },
  ];

  test("acme GitHub queue waits then hands off both failures", async () => {
    let head = async (): Promise<string> => "";
    const queue = createFakeMergeQueue({ headOf: () => head() });
    const h = await start({ settings: { order: "github-queue" }, queue });
    await h.addItem("ACME-queue");
    head = () => h.remoteHead("ACME-queue");
    h.state.ci = () => checks(null);
    expect(await h.pass("ACME-queue")).toMatchObject({
      kind: "wait",
      reason: "ci",
      message: "CI failed: acme test; waiting for acme shard to finish (up to 20 min)",
    });
    expect(await resumes(h)).toEqual([]);
    expect(queue.enqueued).toEqual([]);
    h.state.ci = () => checks("FAILURE");
    expect(await h.pass("ACME-queue")).toEqual({ kind: "returned" });
    expect(await resumes(h)).toHaveLength(1);
    expect((await resumes(h))[0]!.handoff).toContain("acme shard");
  });

  test("acme final squash recheck starts the same collection window", async () => {
    const h = await start();
    await h.addItem("ACME-recheck");
    let reads = 0;
    h.state.ci = () =>
      ++reads === 1
        ? [{ name: "acme test", conclusion: "SUCCESS", detailsUrl: null }]
        : checks(null);
    expect(await h.pass("ACME-recheck")).toMatchObject({ kind: "wait", reason: "ci" });
    expect(await resumes(h)).toEqual([]);
    expect(h.github.merged).toEqual([]);
    h.clock.advance(20 * 60_000);
    expect(await h.pass("ACME-recheck")).toEqual({ kind: "returned" });
    expect(await resumes(h)).toHaveLength(1);
    expect((await resumes(h))[0]!.handoff).toContain(
      "acme shard (https://ci.example/shard): still running",
    );
  });

  test("acme review hold does not enqueue partial CI feedback", async () => {
    const h = await start({ settings: { order: "queue" } });
    const item = await h.addItem("ACME-review");
    h.state.reviews.set(item.pull, "REVIEW_REQUIRED");
    h.state.ci = () => checks(null);
    await h.pass("ACME-review");
    expect(await pendingPullCiFailures(sqliteDb(h.db), "ACME-review")).toEqual([]);
    h.clock.advance(19 * 60_000);
    await h.pass("ACME-review");
    expect(await pendingPullCiFailures(sqliteDb(h.db), "ACME-review")).toEqual([]);
    h.state.ci = () => checks("FAILURE");
    await h.pass("ACME-review");
    const [failure] = await pendingPullCiFailures(sqliteDb(h.db), "ACME-review");
    expect(failure!.failedChecks.map((check) => check.name)).toEqual(["acme test", "acme shard"]);
    expect(await resumes(h)).toEqual([]);
  });
});

test("acme review CI at the cap retains unfinished checks for its feedback handoff", async () => {
  const h = await start({ settings: { order: "queue" } });
  const item = await h.addItem("ACME-review-cap");
  h.state.reviews.set(item.pull, "REVIEW_REQUIRED");
  h.state.ci = () => [
    { name: "acme test", conclusion: "FAILURE", detailsUrl: null },
    { name: "acme shard", conclusion: null, detailsUrl: null },
  ];
  await h.pass("ACME-review-cap");
  h.clock.advance(20 * 60_000);
  await h.pass("ACME-review-cap");
  const [failure] = await pendingPullCiFailures(sqliteDb(h.db), "ACME-review-cap");
  expect(
    failure!.checks.filter((check) => check.waitingForCiFix).map((check) => check.name),
  ).toEqual(["acme shard"]);
  expect(failure!.failedChecks.map((check) => check.name)).toEqual(["acme test"]);
});
