import { afterEach, describe, expect, test } from "bun:test";
import { JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  claimNextJob,
  enqueueJob,
  getConfirmedRemoteMerge,
  getJob,
  getWorkItem,
  joinMergeQueue,
  listCiRounds,
  listJobs,
  listMergeQueues,
  listReviewEscapes,
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

let harness: MergeHarness | undefined;

afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
});

async function start(settings: Parameters<typeof mergeHarness>[0] = {}) {
  harness = await mergeHarness(settings);
  return harness;
}

function resumes(h: MergeHarness) {
  return listJobs(h.db)
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

function queued(h: MergeHarness): string[] {
  return listMergeQueues(h.db).map((entry) => entry.itemId);
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
    expect(queued(h)).toEqual(ids);
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
    expect(queued(h)).toEqual([]);
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
    expect(queued(h)).toEqual(["ENG-111", "ENG-112"]);
    expect(mergedOrder(h, ids)).toEqual(["ENG-114"]);
    expect(h.bodies("afterPullRequest")).toEqual([
      "Waiting for an approving review on pull request #3. It joins the acme/app merge queue once approved.",
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
    const behind = enqueueJob(h.db, {
      queue: JOB_KIND.merge,
      payload: { itemId: "ENG-122", mergeWait: { reason: "ahead" } },
      runAt: h.clock.now() + 300_000,
      now: h.clock.now(),
    });

    const review = enqueueJob(h.db, {
      queue: JOB_KIND.merge,
      payload: { itemId: "ENG-124", mergeWait: { reason: "review" } },
      runAt: h.clock.now() + 300_000,
      now: h.clock.now(),
    });

    const failing = items[0]!.accepted;
    h.state.ci = (head) => (head === failing ? failingTest() : undefined);
    expect(await h.pass("ENG-121")).toEqual({ kind: "returned" });
    expect(getJob(h.db, behind)?.runAt).toBe(h.clock.now());
    expect(getJob(h.db, review)?.runAt).toBe(h.clock.now() + 300_000);
    expect(resumes(h).map((payload) => [payload.itemId, payload.reason])).toEqual([
      ["ENG-121", "ci"],
    ]);
    expect(queued(h)).toEqual(["ENG-122", "ENG-123"]);

    expect(await h.pass("ENG-122")).toEqual({ kind: "merged" });
    await h.requeue("ENG-121", "fixed\n");
    h.clock.advance(1_000);
    expect(await h.pass("ENG-121")).toMatchObject({ kind: "wait", reason: "ahead" });
    expect(queued(h)).toEqual(["ENG-123", "ENG-121"]);
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
    applyWorkItemEvent(h.db, "ENG-141", "reverify_requested");
    expect(
      listMergeQueues(h.db).map((entry) => [entry.itemId, entry.position, entry.busy]),
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
    expect(queued(h)).toEqual(["ENG-141", "ENG-144"]);

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
    expect(ids.map((id) => getWorkItem(h.db, id)?.state)).toEqual(ids.map(() => "merge_queue"));
    expect(listJobs(h.db).filter((job) => job.queue === JOB_KIND.reverify)).toEqual([]);
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
    expect(ids.map((id) => getWorkItem(h.db, id)?.state)).toEqual(ids.map(() => "verifying"));
    const reverify = listJobs(h.db).filter((job) => job.queue === JOB_KIND.reverify);
    expect(reverify.map((job) => (job.payload as { itemId: string }).itemId).toSorted()).toEqual(
      ids,
    );
    expect(new Set(reverify.map((job) => job.status))).toEqual(new Set(["pending"]));
    expect(new Set(reverify.map((job) => job.runAt))).toEqual(new Set([h.clock.now()]));
    expect(listMergeQueues(h.db).map((entry) => [entry.itemId, entry.busy])).toEqual(
      ids.map((id) => [id, true]),
    );
    expect(h.github.merged).toEqual([]);
    // The five Closeout re-runs are claimed side by side, not one after another.
    const running = ids.map(() =>
      claimNextJob(h.db, { queues: [JOB_KIND.reverify], now: h.clock.now() }),
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
    joinMergeQueue(h.db, { itemId: "ENG-131", repository: "acme/app", now: h.clock.now() });
    h.clock.advance(1_000);
    const waiting = enqueueJob(h.db, {
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
    expect(getJob(h.db, waiting)?.runAt).toBe(h.clock.now());

    expect(queued(h)).toEqual(["ENG-131"]);
    expect(await h.pass("ENG-131")).toEqual({ kind: "merged" });
    expect(mergedOrder(h, ids)).toEqual(["ENG-132", "ENG-131"]);
  });

  test("a task with no dependencies behind a blocked one merges without waiting", async () => {
    const h = await start({ settings: { order: "queue" } });
    const ids = ["ENG-141", "ENG-142"];
    for (const id of ids) await h.addItem(id);
    h.state.blockedBy.set("ENG-141", ["ENG-140"]);
    joinMergeQueue(h.db, { itemId: "ENG-141", repository: "acme/app", now: h.clock.now() });
    h.clock.advance(1_000);

    expect(await h.pass("ENG-141")).toMatchObject({ kind: "wait", reason: "dependencies" });
    expect(await h.pass("ENG-142")).toEqual({ kind: "merged" });
    expect(await h.pass("ENG-141")).toMatchObject({ kind: "wait", reason: "dependencies" });
    expect(h.published).toEqual(["ENG-142"]);
    expect(mergedOrder(h, ids)).toEqual(["ENG-142"]);
    // ENG-141 keeps its row, so its place comes back when ENG-140 merges.
    expect(queued(h)).toEqual(["ENG-141"]);
  });
});

describe("advanceMerge on a CI failure", () => {
  test("a failing check goes back to the agent with the end of its log, and the round is recorded", async () => {
    const h = await start();
    const item = await h.addItem("ENG-1");
    h.state.ci = failingTest;
    expect(await h.pass("ENG-1")).toEqual({ kind: "returned" });
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("queued");
    const [resume] = resumes(h);
    expect(resume?.reason).toBe("ci");
    expect(resume?.handoff).toContain(`End of the \`test\` log:\n\`\`\`\n${LOG_TAIL}\n\`\`\``);
    expect(h.bodies("status")).toContain("CI: `test` failed. Sent back to the agent, fix 1 of 3.");
    const rounds = listCiRounds(h.db, "ENG-1");
    expect(rounds).toHaveLength(1);
    expect(rounds[0]).toMatchObject({ head: item.accepted, next: "agent", fix: 1, fixLimit: 3 });
    expect(rounds[0]?.runId).not.toBeNull();
    expect(rounds[0]?.checks.map((check) => [check.name, check.state])).toEqual([
      ["lint", "passed"],
      ["test", "failed"],
      ["e2e", "running"],
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
    expect(listReviewEscapes(h.db)).toEqual([
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
    expect(listReviewEscapes(h.db).map((row) => [row.acceptedHead, row.detail.checks])).toEqual([
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
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("awaiting_input");
    const question = findOpenQuestion(h.db, "ses-ENG-1")!;
    expect(question.body).toContain(
      "The agent used all 1 fix round across Closeout, CI and review.",
    );
    expect(question.body).toContain("- test (https://ci.example/1)");
    const rounds = listCiRounds(h.db, "ENG-1");
    expect(rounds.map((round) => [round.next, round.fix, round.fixLimit])).toEqual([
      ["agent", 1, 1],
      ["asked", null, 1],
    ]);
    expect(new Set(rounds.map((round) => round.head)).size).toBe(2);
    expect(resumes(h)).toHaveLength(1);
  });

  test("with CI fix attempts set to 0, Paws asks on the first failure", async () => {
    const h = await start();
    await h.addItem("ENG-1");
    h.state.ciFixAttempts = 0;
    h.state.ci = failingTest;
    expect(await h.pass("ENG-1")).toEqual({ kind: "asked" });
    expect(findOpenQuestion(h.db, "ses-ENG-1")?.body).toContain("Fix rounds are set to 0");
    expect(resumes(h)).toEqual([]);
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
    expect(findOpenQuestion(h.db, "ses-ENG-1")?.body).toContain(
      "The agent used all 1 fix round across Closeout, CI and review.",
    );
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
    expect(getConfirmedRemoteMerge(h.db, "ENG-1")?.mergeSha).toBe("queue-merge-sha");
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
    const [resume] = resumes(h);
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
    expect(findOpenQuestion(h.db, "ses-ENG-1")).toMatchObject({ reason: "rebase_budget_spent" });
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("awaiting_input");
  });

  test("a person removing the pull request from the queue makes Paws ask in Linear", async () => {
    const { h, queue } = await githubQueue();
    await h.pass("ENG-1");
    queue.remove(1, "MANUAL", "octocat");
    expect(await h.pass("ENG-1")).toEqual({ kind: "asked" });
    expect(getWorkItem(h.db, "ENG-1")?.state).toBe("awaiting_input");
    const body = findOpenQuestion(h.db, "ses-ENG-1")?.body ?? "";
    expect(body).toContain("@octocat removed");
    expect(body).toContain("from the acme/app GitHub merge queue (MANUAL).");
    expect(body).toContain("What should Paws do?");
  });

  test("a queued pull request leaves GitHub's queue when automatic eligibility is revoked", async () => {
    const { h, queue } = await githubQueue();
    let clean = true;
    h.state.risk = () => (clean ? "automatic" : "missing");
    expect(await h.pass("ENG-1")).toMatchObject({
      kind: "wait",
      githubQueue: { queued: true },
    });
    expect(queue.isQueued(1)).toBe(true);
    clean = false;
    expect(await h.pass("ENG-1")).toEqual({ kind: "asked" });
    expect(queue.calls).toContain("dequeue");
    expect(queue.isQueued(1)).toBe(false);
    expect(h.github.merged).toEqual([]);
  });

  test("a merge that lands before eligibility is revoked is recorded instead of asked", async () => {
    const { h, queue } = await githubQueue();
    let clean = true;
    h.state.risk = () => (clean ? "automatic" : "missing");
    expect(await h.pass("ENG-1")).toMatchObject({ kind: "wait" });
    queue.merge(1, "queue-merge-sha");
    clean = false;
    expect(await h.pass("ENG-1")).toEqual({ kind: "merged" });
    expect(h.state.riskAsked).toEqual([]);
    expect(getConfirmedRemoteMerge(h.db, "ENG-1")?.mergeSha).toBe("queue-merge-sha");
  });

  test("a high-risk pull request that was never queued is asked without a dequeue", async () => {
    const { h, queue } = await githubQueue();
    h.state.risk = () => "missing";
    expect(await h.pass("ENG-1")).toEqual({ kind: "asked" });
    expect(queue.calls).not.toContain("dequeue");
    expect(queue.enqueued).toEqual([]);
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
