import { describe, expect, test } from "bun:test";
import { FakeClock, JOB_KIND } from "../core";
import {
  JobLoop,
  beginMergeCall,
  mergeCallInFlight,
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
  listOutbox,
  listRuns,
  markCloseoutAccepted,
  migrate,
  openDatabase,
  sqliteDb,
} from "../db";
import { answerSteps } from "../questions";
import {
  MERGE_BACKSTOP_POLL_MS,
  MERGE_CI_ASK_AFTER_MS,
  MERGE_CI_POLL_MS,
  MERGE_CI_WAIT_MS,
  ciWaitVerification,
  parkMerge,
} from "../merge";
import {
  acceptGitHubDelivery,
  askAboutSlowCi,
  retryMergeLater,
  waitForMergeTurn,
} from "./merge-jobs";
import { questionEffects } from "./question-effects";
import { worktreeBranch } from "./sources";

function queue() {
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(1_000);
  return { db, clock };
}

test("unknown merge outcomes back off without expiring or spending job attempts", async () => {
  const { db, clock } = queue();
  try {
    await insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    const id = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "eng-1", head: "h", ciWaitDeadline: clock.now() - 1 },
      now: clock.now(),
      maxAttempts: 1,
    });
    const loop = new JobLoop(db, clock);
    let reason: "merge_outcome" | "ci" = "merge_outcome";
    let backstop = false;
    loop.register(JOB_KIND.merge, async (job) => {
      expect(await parkMerge(sqliteDb(db), job, clock.now(), { reason })).toBe("parked");
      backstop =
        reason === "ci" &&
        (await getJob(sqliteDb(db), job.id))!.runAt === clock.now() + MERGE_BACKSTOP_POLL_MS;
    });
    for (const delay of [10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]) {
      expect((await loop.tick())?.id).toBe(id);
      const parked = (await getJob(sqliteDb(db), id))!;
      expect(parked.status).toBe("pending");
      expect(parked.attempts).toBe(0);
      expect(parked.runAt).toBe(clock.now() + delay);
      expect(parked.payload).toHaveProperty("ciWaitDeadline", 999);
      clock.advance(delay);
    }
    await beginMergeCall(sqliteDb(db), "eng-1", "h", clock.now());
    const delivery = {
      deliveryId: "uncertain-merge-confirmation",
      event: "pull_request",
      payload: JSON.stringify({
        action: "closed",
        pull_request: { merged: true, head: { sha: "h" } },
      }),
    };
    expect(await acceptGitHubDelivery(db, delivery, clock.now())).toBe(true);
    expect(await acceptGitHubDelivery(db, delivery, clock.now())).toBe(false);
    expect(await mergeCallInFlight(sqliteDb(db), "eng-1")).toBe(true);
    reason = "ci";
    await loop.tick();
    expect(backstop).toBe(true);
  } finally {
    db.close();
  }
});

describe("merge CI wait", () => {
  test("a parked merge remembers what it waits for, for the Merge queue page", async () => {
    const { db, clock } = queue();
    await insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
    let reason: "review" | "ci" = "review";
    loop.register(JOB_KIND.merge, async (job) => {
      await parkMerge(sqliteDb(db), job, clock.now(), {
        queued: reason === "review",
        reason,
        message: reason === "review" ? "Waiting for an approving review." : "CI 4 of 6 done.",
      });
    });
    const ran = await loop.tick();
    expect((await getJob(sqliteDb(db), ran!.id))?.payload).toMatchObject({
      mergeWait: { reason: "review", message: "Waiting for an approving review." },
    });
    reason = "ci";
    clock.advance(60_000);
    await loop.tick();
    expect((await getJob(sqliteDb(db), ran!.id))?.payload).toMatchObject({
      mergeWait: { reason: "ci", message: "CI 4 of 6 done." },
    });
  });

  test("a queued wait that left GitHub's merge queue records it, so the next pass does not ask", async () => {
    const { db, clock } = queue();
    await insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "eng-1", githubQueue: { queued: true, position: 1 } },
      now: clock.now(),
    });
    const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
    loop.register(JOB_KIND.merge, async (job) => {
      await parkMerge(sqliteDb(db), job, clock.now(), {
        queued: true,
        reason: "policy",
        message: "The Closeout policy on main doesn't load.",
        githubQueue: { queued: false },
      });
    });
    const ran = await loop.tick();
    expect((await getJob(sqliteDb(db), ran!.id))?.payload).toMatchObject({
      githubQueue: { queued: false },
    });
  });

  test("a merge whose CI is still pending does not keep a running job", async () => {
    const { db, clock } = queue();
    await insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    await insertQueuedItem(db, { id: "eng-2", now: clock.now() });
    await bindWorkItemRepository(sqliteDb(db), "eng-1", {
      owner: "acme",
      repo: "one",
      remoteUrl: "https://github.com/acme/one.git",
    });
    await bindWorkItemRepository(sqliteDb(db), "eng-2", {
      owner: "acme",
      repo: "one",
      remoteUrl: "https://github.com/acme/one.git",
    });
    await beginImplementRun(sqliteDb(db), "eng-2", clock.now());
    await enterMergeQueue(sqliteDb(db), "eng-2", { phase: "merge_queue", wipCommit: "h" });
    await joinMergeQueue(sqliteDb(db), {
      itemId: "eng-2",
      repository: "acme/one",
      now: clock.now(),
    });
    await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "eng-2" },
      now: clock.now(),
    });
    const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
    loop.register(JOB_KIND.merge, async (job) => {
      expect(await parkMerge(sqliteDb(db), job, clock.now())).toBe("parked");
    });
    const ran = await loop.tick();
    const parked = ran === null ? null : await getJob(sqliteDb(db), ran.id);
    expect(parked?.status).toBe("pending");
    expect(parked?.lockedBy).toBeNull();
    expect(parked?.attempts).toBe(0);
    expect(parked?.runAt).toBe(clock.now() + MERGE_CI_POLL_MS);
    expect(parked?.payload).toMatchObject({
      itemId: "eng-1",
      ciWaitDeadline: clock.now() + MERGE_CI_WAIT_MS,
    });
    const other = await claimNextJob(sqliteDb(db), {
      workerId: "worker",
      leaseMs: 60_000,
      now: clock.now(),
      queues: [JOB_KIND.merge],
    });
    expect(other?.payload).toEqual({ itemId: "eng-2" });
    expect(other?.status).toBe("running");
    clock.advance(MERGE_CI_POLL_MS);
    expect(
      await claimNextJob(sqliteDb(db), {
        workerId: "worker",
        leaseMs: 60_000,
        now: clock.now(),
        queues: [JOB_KIND.merge],
      }),
    ).toBeNull();
    if (other === null) throw new Error("missing claim");
    expect(await completeJob(sqliteDb(db), other, clock.now())).toBe(true);
    expect(
      (await claimNextJob(sqliteDb(db), { now: clock.now(), queues: [JOB_KIND.merge] }))?.payload,
    ).toMatchObject({ itemId: "eng-1" });
  });

  test("CI pending past the wait limit parks at the backstop and does not fail", async () => {
    const { db, clock } = queue();
    await insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    await beginImplementRun(sqliteDb(db), "eng-1", clock.now());
    await enterMergeQueue(sqliteDb(db), "eng-1", { phase: "merge_queue", wipCommit: "h" });
    await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    const first = (await claimNextJob(sqliteDb(db), {
      now: clock.now(),
      queues: [JOB_KIND.merge],
    }))!;
    expect(await parkMerge(sqliteDb(db), first, clock.now(), { reason: "ci", head: "h" })).toBe(
      "parked",
    );
    clock.advance(MERGE_CI_WAIT_MS);
    const again = (await claimNextJob(sqliteDb(db), {
      now: clock.now(),
      queues: [JOB_KIND.merge],
    }))!;
    expect(again.id).toBe(first.id);
    expect(await parkMerge(sqliteDb(db), again, clock.now(), { reason: "ci", head: "h" })).toBe(
      "parked",
    );
    expect(await getJob(sqliteDb(db), first.id)).toMatchObject({
      status: "pending",
      runAt: clock.now() + MERGE_BACKSTOP_POLL_MS,
    });
    expect((await getWorkItem(sqliteDb(db), "eng-1"))?.state).toBe("merge_queue");
  });

  test("CI that turns green during the backstop wait merges once", async () => {
    const { db, clock } = queue();
    await insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    const id = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    const loop = new JobLoop(db, clock);
    let green = false;
    let merges = 0;
    loop.register(JOB_KIND.merge, async (job) => {
      if (green) merges += 1;
      else
        expect(await parkMerge(sqliteDb(db), job, clock.now(), { reason: "ci", head: "h" })).toBe(
          "parked",
        );
    });
    await loop.tick();
    clock.advance(MERGE_CI_WAIT_MS);
    await loop.tick();
    clock.advance(MERGE_BACKSTOP_POLL_MS);
    green = true;
    await loop.tick();
    clock.advance(MERGE_BACKSTOP_POLL_MS);
    await loop.tick();
    expect(merges).toBe(1);
    expect((await getJob(sqliteDb(db), id))?.status).toBe("done");
  });
  test("a reclaimed merge job keeps the verified base, head, and summary", async () => {
    const { db, clock } = queue();
    await insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    await bindWorkItemRepository(sqliteDb(db), "eng-1", {
      owner: "acme",
      repo: "one",
      remoteUrl: "https://github.com/acme/one.git",
    });
    await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    const first = await claimNextJob(sqliteDb(db), { now: clock.now(), queues: [JOB_KIND.merge] });
    if (first === null) throw new Error("missing claim");
    expect(
      await parkMerge(sqliteDb(db), first, clock.now(), {
        base: "base-sha",
        head: "head-sha",
        summary: "accepted once",
      }),
    ).toBe("parked");
    clock.advance(MERGE_CI_POLL_MS);
    const again = await claimNextJob(sqliteDb(db), { now: clock.now(), queues: [JOB_KIND.merge] });
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
    await insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    const id = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "eng-1", head: "head-sha" },
      maxAttempts: 2,
      now: clock.now(),
    });
    const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
    loop.register(JOB_KIND.merge, async (job) => {
      await waitForMergeTurn(sqliteDb(db), job, clock.now());
    });
    for (let pass = 0; pass < 5; pass++) {
      await loop.tick();
      clock.advance(10_000);
    }
    expect(await getJob(sqliteDb(db), id)).toMatchObject({
      status: "pending",
      attempts: 0,
      payload: { itemId: "eng-1", head: "head-sha" },
    });
  });

  test("a failed attempt waits for its backoff and keeps the attempt spent", async () => {
    const { db, clock } = queue();
    await insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    const id = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
    loop.register(JOB_KIND.merge, async (job) => {
      await retryMergeLater(
        sqliteDb(db),
        job,
        clock.now(),
        30_000,
        new Error("GitHub returned 502"),
      );
    });
    await loop.tick();
    expect(await getJob(sqliteDb(db), id)).toMatchObject({
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

  async function parked(githubQueue?: { queued: boolean }) {
    const { db, clock } = queue();
    await insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    const id = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "eng-1", head },
      now: clock.now(),
    });
    const job = await claimNextJob(sqliteDb(db), { now: clock.now(), queues: [JOB_KIND.merge] });
    if (job === null) throw new Error("missing claim");
    await parkMerge(sqliteDb(db), job, clock.now(), {
      base: "b".repeat(40),
      head,
      summary: "accepted",
      ...(githubQueue ? { githubQueue } : {}),
    });
    const branch = worktreeBranch((await getWorkItem(sqliteDb(db), "eng-1"))!);
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

  test("a check_suite delivery for the head wakes its merge job at once", async () => {
    const { db, clock, id } = await parked();
    expect((await getJob(sqliteDb(db), id))?.runAt).toBeGreaterThan(clock.now());
    expect(
      await deliver(db, clock.now(), "check_suite", {
        action: "completed",
        check_suite: { head_sha: head, head_branch: "elsewhere", pull_requests: [] },
      }),
    ).toBe(true);
    expect((await getJob(sqliteDb(db), id))?.runAt).toBe(clock.now());
  });

  test("a check that only started, or a pending status, does not wake the merge job", async () => {
    const { db, clock, id } = await parked();
    const runAt = (await getJob(sqliteDb(db), id))?.runAt;
    await deliver(db, clock.now(), "check_run", {
      action: "created",
      check_run: { head_sha: head },
    });
    await deliver(db, clock.now(), "check_suite", {
      action: "requested",
      check_suite: { head_sha: head },
    });
    await deliver(db, clock.now(), "status", { state: "pending", sha: head });
    expect((await getJob(sqliteDb(db), id))?.runAt).toBe(runAt);
  });

  test("a redelivered delivery id is recorded once and wakes nothing again", async () => {
    const { db, clock, id } = await parked();
    const payload = { state: "success", sha: head, branches: [] };
    expect(await deliver(db, clock.now(), "status", payload)).toBe(true);
    db.run("UPDATE job SET run_at = ? WHERE id = ?", [clock.now() + 60_000, id]);
    expect(await deliver(db, clock.now(), "status", payload)).toBe(false);
    expect((await getJob(sqliteDb(db), id))?.runAt).toBe(clock.now() + 60_000);
  });

  test("check_run, status, pull_request and review deliveries match by head or branch", async () => {
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
      const { db, clock, id, branch } = await parked();
      expect(await deliver(db, clock.now(), event, payload(branch), `d-${index}`)).toBe(true);
      expect((await getJob(sqliteDb(db), id))?.runAt, `${event} ${index}`).toBe(clock.now());
    }
  });

  test("a delivery for another head or branch leaves the merge job parked", async () => {
    const { db, clock, id } = await parked();
    const runAt = (await getJob(sqliteDb(db), id))?.runAt;
    await deliver(db, clock.now(), "pull_request", {
      pull_request: { head: { sha: "c".repeat(40), ref: "paws/eng-2" } },
    });
    await deliver(db, clock.now(), "merge_group", { merge_group: { head_sha: "d".repeat(40) } });
    expect((await getJob(sqliteDb(db), id))?.runAt).toBe(runAt);
  });

  test("a merge_group delivery wakes merges in GitHub's merge queue", async () => {
    const { db, clock, id } = await parked({ queued: true });
    await deliver(db, clock.now(), "merge_group", {
      action: "destroyed",
      merge_group: { head_sha: "d".repeat(40), head_ref: "refs/heads/gh-readonly-queue/main/pr-7" },
    });
    expect((await getJob(sqliteDb(db), id))?.runAt).toBe(clock.now());
  });

  test("a delivery while the merge job runs makes its next pass run at once", async () => {
    const { db, clock, id } = await parked();
    clock.advance(MERGE_CI_POLL_MS);
    const job = await claimNextJob(sqliteDb(db), { now: clock.now(), queues: [JOB_KIND.merge] });
    expect(job?.id).toBe(id);
    clock.advance(1_000);
    await deliver(db, clock.now(), "check_suite", {
      action: "completed",
      check_suite: { head_sha: head },
    });
    expect(await parkMerge(sqliteDb(db), job!, clock.now(), { head })).toBe("parked");
    expect(await getJob(sqliteDb(db), id)).toMatchObject({ status: "pending", runAt: clock.now() });
  });
});

describe("main moving", () => {
  const main = "c".repeat(40);
  const repository = { full_name: "acme/app", default_branch: "main" };

  async function twoQueued() {
    const { db, clock } = queue();
    for (const id of ["eng-1", "eng-2"]) {
      await insertQueuedItem(db, { id, now: clock.now() });
      await beginImplementRun(sqliteDb(db), id, clock.now());
      await enterMergeQueue(sqliteDb(db), id, {
        phase: "merge_queue",
        baseSha: "b".repeat(40),
        wipCommit: id,
      });
      await joinMergeQueue(sqliteDb(db), { itemId: id, repository: "acme/app", now: clock.now() });
      clock.advance(1_000);
    }
    return { db, clock };
  }

  async function sweeps(db: ReturnType<typeof queue>["db"]) {
    return (await listJobs(sqliteDb(db)))
      .filter((job) => job.queue === JOB_KIND.queueConflicts)
      .map((job) => job.payload);
  }

  test("a push to the default branch, its redelivery and the merged pull request check the queue once", async () => {
    const { db, clock } = await twoQueued();
    const push = { ref: "refs/heads/main", after: main, repository };
    await acceptGitHubDelivery(
      db,
      { deliveryId: "p-1", event: "push", payload: JSON.stringify(push) },
      clock.now(),
    );
    await acceptGitHubDelivery(
      db,
      { deliveryId: "p-2", event: "push", payload: JSON.stringify(push) },
      clock.now(),
    );
    await acceptGitHubDelivery(
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
    expect(await sweeps(db)).toEqual([{ repository: "acme/app", main }]);
  });

  test("a push to another branch or a closed unmerged pull request checks nothing", async () => {
    const { db, clock } = await twoQueued();
    await acceptGitHubDelivery(
      db,
      {
        deliveryId: "p-1",
        event: "push",
        payload: JSON.stringify({ ref: "refs/heads/paws/eng-1", after: main, repository }),
      },
      clock.now(),
    );
    await acceptGitHubDelivery(
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
    expect(await sweeps(db)).toEqual([]);
  });
});

describe("merge poll backstop", () => {
  async function ciWait() {
    const { db, clock } = queue();
    await insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    const id = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    let reads = 0;
    const loop = new JobLoop(db, clock, { leaseMs: 60_000 });
    loop.register(JOB_KIND.merge, async (job) => {
      reads += 1;
      await parkMerge(sqliteDb(db), job, clock.now(), { base: "b", head: "h", summary: "s" });
    });
    return { db, clock, id, loop, reads: () => reads };
  }

  async function ping(db: ReturnType<typeof queue>["db"], now: number, deliveryId = "ping") {
    await acceptGitHubDelivery(db, { deliveryId, event: "ping", payload: "{}" }, now);
  }

  test("with deliveries flowing, a 20-minute CI wait makes at most 5 GitHub status reads", async () => {
    const { db, clock, loop, reads } = await ciWait();
    await ping(db, clock.now());
    for (let elapsed = 0; elapsed <= 20 * 60_000; elapsed += MERGE_CI_POLL_MS) {
      await loop.tick();
      clock.advance(MERGE_CI_POLL_MS);
    }
    expect(reads()).toBeLessThanOrEqual(5);
    expect(reads()).toBeGreaterThan(1);
  });

  test("a CI wait polls every 10 seconds when no delivery arrived in the last hour", async () => {
    const { db, clock, id, loop } = await ciWait();
    await ping(db, clock.now());
    clock.advance(60 * 60_000);
    await loop.tick();
    expect((await getJob(sqliteDb(db), id))?.runAt).toBe(clock.now() + MERGE_CI_POLL_MS);
    await ping(db, clock.now(), "ping-2");
    clock.advance(MERGE_CI_POLL_MS);
    await loop.tick();
    expect((await getJob(sqliteDb(db), id))?.runAt).toBe(clock.now() + MERGE_BACKSTOP_POLL_MS);
  });

  test("a wait for a review or the queue polls every 5 minutes while deliveries flow", async () => {
    const { db, clock } = queue();
    await insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    const id = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    await ping(db, clock.now());
    const job = await claimNextJob(sqliteDb(db), { now: clock.now(), queues: [JOB_KIND.merge] });
    await parkMerge(sqliteDb(db), job!, clock.now(), { queued: true, reason: "review" });
    expect((await getJob(sqliteDb(db), id))?.runAt).toBe(clock.now() + MERGE_BACKSTOP_POLL_MS);
  });
});

describe("slow CI question", () => {
  const checks = "Waiting for checks: lint, test (1/4)";

  async function askedAboutSlowCi() {
    const { db, clock } = queue();
    await insertQueuedItem(db, { id: "eng-1", sessionKey: "ses", now: clock.now() });
    await beginImplementRun(sqliteDb(db), "eng-1", clock.now());
    await enterMergeQueue(sqliteDb(db), "eng-1", { phase: "merge_queue", wipCommit: "h" });
    await markCloseoutAccepted(sqliteDb(db), "eng-1", "h");
    await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.merge,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    const first = (await claimNextJob(sqliteDb(db), {
      now: clock.now(),
      queues: [JOB_KIND.merge],
    }))!;
    expect(await parkMerge(sqliteDb(db), first, clock.now(), { reason: "ci", head: "h" })).toBe(
      "parked",
    );
    clock.advance(MERGE_CI_ASK_AFTER_MS);
    const again = (await claimNextJob(sqliteDb(db), {
      now: clock.now(),
      queues: [JOB_KIND.merge],
    }))!;
    expect(await parkMerge(sqliteDb(db), again, clock.now(), { reason: "ci", head: "h" })).toBe(
      "ask",
    );
    expect(await askAboutSlowCi(sqliteDb(db), "eng-1", { checks, now: clock.now() })).toBe(true);
    expect(await askAboutSlowCi(sqliteDb(db), "eng-1", { checks, now: clock.now() })).toBe(false);
    await completeJob(sqliteDb(db), again, clock.now());
    return { db, clock };
  }

  async function reply(db: ReturnType<typeof queue>["db"], body: string, now: number) {
    return (
      await sqliteDb(db).transaction((q) =>
        answerSteps(
          q,
          { sessionId: "ses", deliveryId: `reply:${body}`, body, answeredBy: "pascal", now },
          questionEffects(sqliteDb(db), { now }),
        ),
      )
    ).status;
  }

  test("CI pending for six hours asks once and names the pending checks and branch", async () => {
    const { db } = await askedAboutSlowCi();
    const questions = db
      .query<{ body: string; options: string }, []>("SELECT body, options FROM question")
      .all();
    expect(questions).toHaveLength(1);
    expect(questions[0]!.body).toContain(checks);
    expect(questions[0]!.body).toContain(
      `\`${worktreeBranch((await getWorkItem(sqliteDb(db), "eng-1"))!)}\``,
    );
    expect(JSON.parse(questions[0]!.options)).toEqual(["Merge the accepted work", "Stop"]);
    expect((await getWorkItem(sqliteDb(db), "eng-1"))?.state).toBe("awaiting_input");
  });

  test("Merge returns the accepted head to the merge queue and starts a fresh wait", async () => {
    const { db, clock } = await askedAboutSlowCi();
    const runs = (await listRuns(sqliteDb(db), "eng-1")).length;
    expect(await reply(db, "Merge the accepted work", clock.now())).toBe("answered");
    expect(await getWorkItem(sqliteDb(db), "eng-1")).toMatchObject({
      state: "merge_queue",
      acceptedHead: "h",
    });
    expect(await listRuns(sqliteDb(db), "eng-1")).toHaveLength(runs);
    const job = (await claimNextJob(sqliteDb(db), { now: clock.now(), queues: [JOB_KIND.merge] }))!;
    expect(job.payload).toMatchObject({ itemId: "eng-1", head: "h" });
    expect(await parkMerge(sqliteDb(db), job, clock.now(), { reason: "ci", head: "h" })).toBe(
      "parked",
    );
    expect(await getJob(sqliteDb(db), job.id)).toMatchObject({
      runAt: clock.now() + MERGE_CI_POLL_MS,
      payload: { ciWaitStartedAt: clock.now(), ciWaitDeadline: clock.now() + MERGE_CI_WAIT_MS },
    });
  });

  test("Stop fails the item by answer and keeps the accepted branch", async () => {
    const { db, clock } = await askedAboutSlowCi();
    expect(await reply(db, "Stop", clock.now())).toBe("answered");
    expect((await getWorkItem(sqliteDb(db), "eng-1"))?.state).toBe("failed");
    const event = db
      .query<{ event: string }, []>("SELECT event FROM work_item_event ORDER BY id DESC LIMIT 1")
      .get();
    expect(event?.event).toBe("answer_stopped");
    expect((await listOutbox(sqliteDb(db))).at(-1)?.payload).toMatchObject({
      kind: "error",
      body: expect.stringMatching(
        /^Stopped while GitHub CI was pending, as asked in Linear\. The accepted work is on branch `.+`\.$/,
      ),
    });
    expect((await listJobs(sqliteDb(db))).some((job) => job.status === "pending")).toBe(false);
  });
});
