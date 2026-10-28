import { describe, expect, test } from "bun:test";
import { FakeClock, JOB_KIND, MERGE_LANE } from "../core";
import {
  JobLoop,
  bindWorkItemRepository,
  claimNextJob,
  completeJob,
  enqueueJob,
  getJob,
  getWorkItem,
  beginImplementRun,
  enterMergeQueue,
  insertQueuedItem,
  joinMergeQueue,
  listJobs,
  migrate,
  openDatabase,
} from "../db";
import {
  MERGE_BACKSTOP_POLL_MS,
  MERGE_CI_POLL_MS,
  MERGE_CI_WAIT_MS,
  ciWaitVerification,
  parkMerge,
} from "../merge";
import { acceptGitHubDelivery, retryMergeLater, waitForMergeTurn } from "./merge-jobs";
import { worktreeBranch } from "./sources";

function queue() {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(1_000);
  return { db, clock };
}

describe("merge CI wait", () => {
  test("a parked merge remembers what it waits for, for the Merge queue page", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
    let reason: "review" | "ci" = "review";
    loop.register(JOB_KIND.merge, (job) => {
      parkMerge(db, job, clock.now(), {
        queued: reason === "review",
        reason,
        message: reason === "review" ? "Waiting for an approving review." : "CI 4 of 6 done.",
      });
    });
    const ran = await loop.tick();
    expect(getJob(db, ran!.id)?.payload).toMatchObject({
      mergeWait: { reason: "review", message: "Waiting for an approving review." },
    });
    reason = "ci";
    clock.advance(60_000);
    await loop.tick();
    expect(getJob(db, ran!.id)?.payload).toMatchObject({
      mergeWait: { reason: "ci", message: "CI 4 of 6 done." },
    });
  });

  test("a merge whose CI is still pending does not keep a running job", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    insertQueuedItem(db, { id: "eng-2", now: clock.now() });
    bindWorkItemRepository(db, "eng-1", {
      owner: "acme",
      repo: "one",
      remoteUrl: "https://github.com/acme/one.git",
    });
    bindWorkItemRepository(db, "eng-2", {
      owner: "acme",
      repo: "one",
      remoteUrl: "https://github.com/acme/one.git",
    });
    enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-2" },
      now: clock.now(),
    });
    const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
    loop.register(JOB_KIND.merge, (job) => {
      expect(parkMerge(db, job, clock.now())).toBe("parked");
    });
    const ran = await loop.tick();
    const parked = ran === null ? null : getJob(db, ran.id);
    expect(parked?.status).toBe("pending");
    expect(parked?.lockedBy).toBeNull();
    expect(parked?.attempts).toBe(0);
    expect(parked?.runAt).toBe(clock.now() + MERGE_CI_POLL_MS);
    expect(parked?.payload).toMatchObject({
      itemId: "eng-1",
      ciWaitDeadline: clock.now() + MERGE_CI_WAIT_MS,
    });
    const other = claimNextJob(db, {
      workerId: "worker",
      leaseMs: 60_000,
      now: clock.now(),
      queues: [JOB_KIND.merge],
    });
    expect(other?.payload).toEqual({ itemId: "eng-2" });
    expect(other?.status).toBe("running");
    clock.advance(MERGE_CI_POLL_MS);
    expect(
      claimNextJob(db, {
        workerId: "worker",
        leaseMs: 60_000,
        now: clock.now(),
        queues: [JOB_KIND.merge],
      }),
    ).toBeNull();
    if (other === null) throw new Error("missing claim");
    expect(completeJob(db, other, clock.now())).toBe(true);
    expect(claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.merge] })?.payload).toMatchObject(
      { itemId: "eng-1" },
    );
  });

  test("a merge CI wait expires instead of parking past the limit", () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    bindWorkItemRepository(db, "eng-1", {
      owner: "acme",
      repo: "one",
      remoteUrl: "https://github.com/acme/one.git",
    });
    enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    const first = claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.merge] });
    if (first === null) throw new Error("missing claim");
    expect(parkMerge(db, first, clock.now())).toBe("parked");
    clock.advance(MERGE_CI_WAIT_MS);
    const again = claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.merge] });
    if (again === null) throw new Error("missing claim");
    expect(again.id).toBe(first.id);
    expect(parkMerge(db, again, clock.now())).toBe("expired");
    expect(getJob(db, first.id)?.status).toBe("running");
  });

  test("a reclaimed merge job keeps the verified base, head, and summary", () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    bindWorkItemRepository(db, "eng-1", {
      owner: "acme",
      repo: "one",
      remoteUrl: "https://github.com/acme/one.git",
    });
    enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    const first = claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.merge] });
    if (first === null) throw new Error("missing claim");
    expect(
      parkMerge(db, first, clock.now(), {
        base: "base-sha",
        head: "head-sha",
        summary: "accepted once",
      }),
    ).toBe("parked");
    clock.advance(MERGE_CI_POLL_MS);
    const again = claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.merge] });
    expect(again?.id).toBe(first.id);
    expect(ciWaitVerification(again?.payload)).toEqual({
      base: "base-sha",
      head: "head-sha",
      summary: "accepted once",
    });
  });
});

describe("merge job retries", () => {
  test("waiting for the task's other job does not spend an attempt", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    const id = enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-1", head: "head-sha" },
      maxAttempts: 2,
      now: clock.now(),
    });
    const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
    loop.register(JOB_KIND.merge, (job) => {
      waitForMergeTurn(db, job, clock.now());
    });
    for (let pass = 0; pass < 5; pass++) {
      await loop.tick();
      clock.advance(10_000);
    }
    expect(getJob(db, id)).toMatchObject({
      status: "pending",
      attempts: 0,
      payload: { itemId: "eng-1", head: "head-sha" },
    });
  });

  test("a failed attempt waits for its backoff and keeps the attempt spent", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    const id = enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
    loop.register(JOB_KIND.merge, (job) => {
      retryMergeLater(db, job, clock.now(), 30_000, new Error("GitHub returned 502"));
    });
    await loop.tick();
    expect(getJob(db, id)).toMatchObject({
      status: "pending",
      attempts: 1,
      runAt: clock.now() + 30_000,
      lastError: "GitHub returned 502",
    });
    clock.advance(29_000);
    expect(await loop.tick()).toBeNull();
  });
});

describe("GitHub deliveries", () => {
  const head = "a".repeat(40);

  function parked(githubQueue?: { queued: boolean }) {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    const id = enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-1", head },
      now: clock.now(),
    });
    const job = claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.merge] });
    if (job === null) throw new Error("missing claim");
    parkMerge(db, job, clock.now(), {
      base: "b".repeat(40),
      head,
      summary: "accepted",
      ...(githubQueue ? { githubQueue } : {}),
    });
    const branch = worktreeBranch(getWorkItem(db, "eng-1")!);
    return { db, clock, id, branch };
  }

  function deliver(
    db: ReturnType<typeof queue>["db"],
    now: number,
    event: string,
    payload: unknown,
    deliveryId = `d-${event}`,
  ) {
    return acceptGitHubDelivery(db, { deliveryId, event, payload: JSON.stringify(payload) }, now);
  }

  test("a check_suite delivery for the head wakes its merge job at once", () => {
    const { db, clock, id } = parked();
    expect(getJob(db, id)?.runAt).toBeGreaterThan(clock.now());
    expect(
      deliver(db, clock.now(), "check_suite", {
        action: "completed",
        check_suite: { head_sha: head, head_branch: "elsewhere", pull_requests: [] },
      }),
    ).toBe(true);
    expect(getJob(db, id)?.runAt).toBe(clock.now());
  });

  test("a check that only started, or a pending status, does not wake the merge job", () => {
    const { db, clock, id } = parked();
    const runAt = getJob(db, id)?.runAt;
    deliver(db, clock.now(), "check_run", { action: "created", check_run: { head_sha: head } });
    deliver(db, clock.now(), "check_suite", {
      action: "requested",
      check_suite: { head_sha: head },
    });
    deliver(db, clock.now(), "status", { state: "pending", sha: head });
    expect(getJob(db, id)?.runAt).toBe(runAt);
  });

  test("a redelivered delivery id is recorded once and wakes nothing again", () => {
    const { db, clock, id } = parked();
    const payload = { state: "success", sha: head, branches: [] };
    expect(deliver(db, clock.now(), "status", payload)).toBe(true);
    db.run("UPDATE job SET run_at = ? WHERE id = ?", [clock.now() + 60_000, id]);
    expect(deliver(db, clock.now(), "status", payload)).toBe(false);
    expect(getJob(db, id)?.runAt).toBe(clock.now() + 60_000);
  });

  test("check_run, status, pull_request and review deliveries match by head or branch", () => {
    const cases: [string, (branch: string) => unknown][] = [
      [
        "check_run",
        () => ({
          action: "completed",
          check_run: { head_sha: head, check_suite: { head_branch: null } },
        }),
      ],
      [
        "check_run",
        (branch) => ({
          action: "completed",
          check_run: { head_sha: "c".repeat(40), check_suite: { head_branch: branch } },
        }),
      ],
      ["status", (branch) => ({ sha: "c".repeat(40), branches: [{ name: branch }] })],
      [
        "pull_request",
        (branch) => ({
          action: "synchronize",
          pull_request: { head: { sha: "c".repeat(40), ref: branch } },
        }),
      ],
      [
        "pull_request_review",
        () => ({ action: "submitted", pull_request: { head: { sha: head, ref: "other" } } }),
      ],
    ];
    for (const [index, [event, payload]] of cases.entries()) {
      const { db, clock, id, branch } = parked();
      expect(deliver(db, clock.now(), event, payload(branch), `d-${index}`)).toBe(true);
      expect(getJob(db, id)?.runAt, `${event} ${index}`).toBe(clock.now());
    }
  });

  test("a delivery for another head or branch leaves the merge job parked", () => {
    const { db, clock, id } = parked();
    const runAt = getJob(db, id)?.runAt;
    deliver(db, clock.now(), "pull_request", {
      pull_request: { head: { sha: "c".repeat(40), ref: "paws/eng-2" } },
    });
    deliver(db, clock.now(), "merge_group", { merge_group: { head_sha: "d".repeat(40) } });
    expect(getJob(db, id)?.runAt).toBe(runAt);
  });

  test("a merge_group delivery wakes merges in GitHub's merge queue", () => {
    const { db, clock, id } = parked({ queued: true });
    deliver(db, clock.now(), "merge_group", {
      action: "destroyed",
      merge_group: { head_sha: "d".repeat(40), head_ref: "refs/heads/gh-readonly-queue/main/pr-7" },
    });
    expect(getJob(db, id)?.runAt).toBe(clock.now());
  });

  test("a delivery while the merge job runs makes its next pass run at once", () => {
    const { db, clock, id } = parked();
    clock.advance(MERGE_CI_POLL_MS);
    const job = claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.merge] });
    expect(job?.id).toBe(id);
    clock.advance(1_000);
    deliver(db, clock.now(), "check_suite", {
      action: "completed",
      check_suite: { head_sha: head },
    });
    expect(parkMerge(db, job!, clock.now(), { head })).toBe("parked");
    expect(getJob(db, id)).toMatchObject({ status: "pending", runAt: clock.now() });
  });
});

describe("main moving", () => {
  const main = "c".repeat(40);
  const repository = { full_name: "acme/app", default_branch: "main" };

  function twoQueued() {
    const { db, clock } = queue();
    for (const id of ["eng-1", "eng-2"]) {
      insertQueuedItem(db, { id, now: clock.now() });
      beginImplementRun(db, id, clock.now());
      enterMergeQueue(db, id, { phase: "merge_queue", baseSha: "b".repeat(40), wipCommit: id });
      joinMergeQueue(db, { itemId: id, repository: "acme/app", now: clock.now() });
      clock.advance(1_000);
    }
    return { db, clock };
  }

  function sweeps(db: ReturnType<typeof queue>["db"]) {
    return listJobs(db)
      .filter((job) => job.queue === JOB_KIND.queueConflicts)
      .map((job) => job.payload);
  }

  test("a push to the default branch, its redelivery and the merged pull request check the queue once", () => {
    const { db, clock } = twoQueued();
    const push = { ref: "refs/heads/main", after: main, repository };
    acceptGitHubDelivery(
      db,
      { deliveryId: "p-1", event: "push", payload: JSON.stringify(push) },
      clock.now(),
    );
    acceptGitHubDelivery(
      db,
      { deliveryId: "p-2", event: "push", payload: JSON.stringify(push) },
      clock.now(),
    );
    acceptGitHubDelivery(
      db,
      {
        deliveryId: "pr-1",
        event: "pull_request",
        payload: JSON.stringify({
          action: "closed",
          pull_request: {
            merged: true,
            merge_commit_sha: main,
            base: { ref: "main" },
            head: { sha: "d".repeat(40), ref: "paws/other" },
          },
          repository,
        }),
      },
      clock.now(),
    );
    expect(sweeps(db)).toEqual([{ repository: "acme/app", main }]);
  });

  test("a push to another branch or a closed unmerged pull request checks nothing", () => {
    const { db, clock } = twoQueued();
    acceptGitHubDelivery(
      db,
      {
        deliveryId: "p-1",
        event: "push",
        payload: JSON.stringify({ ref: "refs/heads/paws/eng-1", after: main, repository }),
      },
      clock.now(),
    );
    acceptGitHubDelivery(
      db,
      {
        deliveryId: "pr-1",
        event: "pull_request",
        payload: JSON.stringify({
          action: "closed",
          pull_request: { merged: false, base: { ref: "main" } },
          repository,
        }),
      },
      clock.now(),
    );
    expect(sweeps(db)).toEqual([]);
  });
});

describe("merge poll backstop", () => {
  function ciWait() {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    const id = enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    let reads = 0;
    const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
    loop.register(JOB_KIND.merge, (job) => {
      reads += 1;
      parkMerge(db, job, clock.now(), { base: "b", head: "h", summary: "s" });
    });
    return { db, clock, id, loop, reads: () => reads };
  }

  function ping(db: ReturnType<typeof queue>["db"], now: number, deliveryId = "ping") {
    acceptGitHubDelivery(db, { deliveryId, event: "ping", payload: "{}" }, now);
  }

  test("with deliveries flowing, a 20-minute CI wait makes at most 5 GitHub status reads", async () => {
    const { db, clock, loop, reads } = ciWait();
    ping(db, clock.now());
    for (let elapsed = 0; elapsed <= 20 * 60_000; elapsed += MERGE_CI_POLL_MS) {
      await loop.tick();
      clock.advance(MERGE_CI_POLL_MS);
    }
    expect(reads()).toBeLessThanOrEqual(5);
    expect(reads()).toBeGreaterThan(1);
  });

  test("a CI wait polls every 10 seconds when no delivery arrived in the last hour", async () => {
    const { db, clock, id, loop } = ciWait();
    ping(db, clock.now());
    clock.advance(60 * 60_000);
    await loop.tick();
    expect(getJob(db, id)?.runAt).toBe(clock.now() + MERGE_CI_POLL_MS);
    ping(db, clock.now(), "ping-2");
    clock.advance(MERGE_CI_POLL_MS);
    await loop.tick();
    expect(getJob(db, id)?.runAt).toBe(clock.now() + MERGE_BACKSTOP_POLL_MS);
  });

  test("a wait for a review or the queue polls every 5 minutes while deliveries flow", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    const id = enqueueJob(db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    ping(db, clock.now());
    const job = claimNextJob(db, { now: clock.now(), queues: [JOB_KIND.merge] });
    parkMerge(db, job!, clock.now(), { queued: true, reason: "review" });
    expect(getJob(db, id)?.runAt).toBe(clock.now() + MERGE_BACKSTOP_POLL_MS);
  });
});
