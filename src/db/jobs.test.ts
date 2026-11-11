import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  bindWorkItemRepository,
  actionableDue,
  cancelOpenJobs,
  claimNextJob,
  completeJob,
  enqueueJob,
  enqueueJobOnce,
  reenqueueJob,
  jobVersionCurrent,
  failJob,
  extendJobLease,
  getJob,
  insertQueuedItem,
  joinMergeQueue,
  leaveMergeQueue,
  listJobs,
  listMergeQueues,
  migrate,
  openDatabase,
  parkLeasedJob,
  retryLeasedJob,
  sqliteDb,
} from "./index";

function queue(clock = new FakeClock(1_000), leaseMs = 5_000) {
  const db = openDatabase(":memory:");
  migrate(db);
  return { db, clock, leaseMs };
}

async function bindRepo(
  db: ReturnType<typeof queue>["db"],
  itemId: string,
  owner: string,
  repo: string,
) {
  await bindWorkItemRepository(sqliteDb(db), itemId, {
    owner,
    repo,
    remoteUrl: `https://github.com/${owner}/${repo}.git`,
  });
}

async function enqueueMerge(db: ReturnType<typeof queue>["db"], clock: FakeClock, itemId: string) {
  return await enqueueJob(sqliteDb(db), {
    queue: JOB_KIND.merge,
    payload: { itemId },
    now: clock.now(),
  });
}

async function claim(
  db: ReturnType<typeof queue>["db"],
  clock: FakeClock,
  queues: string[],
  workerId = "worker",
  leaseMs = 5_000,
) {
  return await claimNextJob(sqliteDb(db), { workerId, leaseMs, now: clock.now(), queues });
}

async function holdMergeQueuePlace(
  db: ReturnType<typeof openDatabase>,
  clock: FakeClock,
  id: string,
  lane = "",
) {
  await beginImplementRun(sqliteDb(db), id, clock.now());
  await applyWorkItemEvent(sqliteDb(db), id, "turn_ended");
  await applyWorkItemEvent(sqliteDb(db), id, "closeout_accepted");
  await joinMergeQueue(sqliteDb(db), {
    itemId: id,
    repository: "acme/one",
    lane,
    now: clock.now(),
  });
}

describe("job queue", () => {
  test("item cancellation stays local while explicit merge-lane cancellation unions scopes", async () => {
    const { db, clock } = queue();
    const own = await enqueueMerge(db, clock, "own");
    const other = await enqueueMerge(db, clock, "other");
    const otherResume = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.resume,
      payload: { itemId: "other" },
      now: clock.now(),
    });
    const command = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.command,
      payload: { itemId: "own" },
      now: clock.now(),
    });
    expect(
      await cancelOpenJobs(sqliteDb(db), { itemId: "own", reason: "local", now: clock.now() }),
    ).toBe(1);
    expect((await getJob(sqliteDb(db), own))?.status).toBe("cancelled");
    expect((await getJob(sqliteDb(db), other))?.status).toBe("pending");
    expect((await getJob(sqliteDb(db), otherResume))?.status).toBe("pending");

    const ownResume = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.resume,
      payload: { itemId: "own" },
      now: clock.now(),
    });
    expect(
      await cancelOpenJobs(sqliteDb(db), {
        itemId: "own",
        mergeLane: true,
        reason: "global",
        now: clock.now(),
      }),
    ).toBe(2);
    expect((await getJob(sqliteDb(db), ownResume))?.status).toBe("cancelled");
    expect((await getJob(sqliteDb(db), other))?.status).toBe("cancelled");
    expect((await getJob(sqliteDb(db), otherResume))?.status).toBe("pending");
    expect((await getJob(sqliteDb(db), command))?.status).toBe("pending");
    db.close();
  });

  test("a timer row stays unclaimed until its run_at", async () => {
    const { db, clock } = queue();
    await enqueueJob(sqliteDb(db), { queue: "tick", runAt: clock.now() + 5_000, now: clock.now() });
    expect(await claim(db, clock, ["tick"])).toBeNull();
    clock.advance(5_000);
    expect((await claim(db, clock, ["tick"]))?.queue).toBe("tick");
  });

  test("actionable due work matches what a claim can take", async () => {
    const { db, clock } = queue();
    const due = await enqueueJob(sqliteDb(db), {
      queue: "tick",
      runAt: clock.now() - 1_000,
      now: clock.now(),
    });
    await enqueueJob(sqliteDb(db), { queue: "tick", runAt: clock.now() + 5_000, now: clock.now() });
    await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.start,
      payload: { itemId: "unreserved" },
      runAt: clock.now() - 60_000,
      now: clock.now(),
    });
    expect(await actionableDue(sqliteDb(db), clock.now())).toEqual({
      count: 1,
      oldestRunAt: clock.now() - 1_000,
    });
    expect((await claim(db, clock, ["tick"]))?.id).toBe(due);
    expect(await actionableDue(sqliteDb(db), clock.now())).toEqual({ count: 0, oldestRunAt: null });
  });

  test("an unregistered queue does not block a job this process can run", async () => {
    const { db, clock } = queue();
    await enqueueJob(sqliteDb(db), { queue: "mystery", now: clock.now() });
    await enqueueJob(sqliteDb(db), { queue: "work", now: clock.now() });
    const claimed = await claim(db, clock, ["work"]);
    expect(claimed?.queue).toBe("work");
    expect((await listJobs(sqliteDb(db))).find((job) => job.queue === "mystery")?.status).toBe(
      "pending",
    );
  });

  test("stop commands are claimed ahead of other due work", async () => {
    const { db, clock } = queue();
    await enqueueJob(sqliteDb(db), { queue: "work", now: clock.now() });
    await enqueueJob(sqliteDb(db), { queue: "core.command", priority: 0, now: clock.now() });
    expect((await claim(db, clock, ["work", "core.command"]))?.queue).toBe("core.command");
  });

  test("a second worker cannot take a live lease, and an expired lease can be reclaimed", async () => {
    const { db, clock } = queue(new FakeClock(0), 1_000);
    await enqueueJob(sqliteDb(db), { queue: "work", maxAttempts: 5, now: clock.now() });
    const first = await claim(db, clock, ["work"], "a", 1_000);
    expect(first).not.toBeNull();
    clock.advance(999);
    expect(await claim(db, clock, ["work"], "b", 1_000)).toBeNull();
    clock.advance(1);
    const second = await claim(db, clock, ["work"], "b", 1_000);
    expect(second?.id).toBe(first?.id);
    expect(second?.attempts).toBe(2);
    expect(first !== null && (await completeJob(sqliteDb(db), first, clock.now()))).toBe(false);
    expect(second !== null && (await completeJob(sqliteDb(db), second, clock.now()))).toBe(true);
    expect(second !== null && (await getJob(sqliteDb(db), second.id))?.status).toBe("done");
  });

  test("retries with backoff and then fails the job", async () => {
    const { db, clock } = queue();
    const created = await enqueueJob(sqliteDb(db), {
      queue: "work",
      maxAttempts: 2,
      now: clock.now(),
    });
    const first = await claim(db, clock, ["work"]);
    expect(first).not.toBeNull();
    const retried =
      first === null
        ? null
        : await failJob(sqliteDb(db), first, new Error("nope"), { now: clock.now() });
    expect(retried?.status).toBe("pending");
    expect(retried?.runAt).toBe(clock.now() + 1_000);
    expect(await claim(db, clock, ["work"])).toBeNull();
    clock.advance(1_000);
    const second = await claim(db, clock, ["work"]);
    expect(second?.attempts).toBe(2);
    expect(
      second !== null &&
        (await failJob(sqliteDb(db), second, new Error("still nope"), { now: clock.now() }))
          ?.status,
    ).toBe("dead");
    expect(
      (await listJobs(sqliteDb(db))).filter((job) => job.status === "dead").map((job) => job.id),
    ).toEqual([created]);
    expect(await claim(db, clock, ["work"])).toBeNull();
  });

  test("a recurring row arms its next fire after success", async () => {
    const { db, clock } = queue();
    await enqueueJob(sqliteDb(db), { queue: "poll", recurringEveryMs: 5_000, now: clock.now() });
    const first = await claim(db, clock, ["poll"]);
    expect(first !== null && (await completeJob(sqliteDb(db), first, clock.now()))).toBe(true);
    const armed = first === null ? null : await getJob(sqliteDb(db), first.id);
    expect(armed?.status).toBe("pending");
    expect(armed?.fireCount).toBe(1);
    expect(armed?.attempts).toBe(0);
    expect(armed?.runAt).toBe(clock.now() + 5_000);
    clock.advance(4_999);
    expect(await claim(db, clock, ["poll"])).toBeNull();
    clock.advance(1);
    const second = await claim(db, clock, ["poll"]);
    expect(second !== null && (await completeJob(sqliteDb(db), second, clock.now()))).toBe(true);
    expect(first !== null && (await getJob(sqliteDb(db), first.id))?.fireCount).toBe(2);
  });

  test("a recurring row that exhausts its attempts still arms the next fire", async () => {
    const { db, clock } = queue();
    const created = await enqueueJob(sqliteDb(db), {
      queue: "poll",
      recurringEveryMs: 5_000,
      maxAttempts: 1,
      now: clock.now(),
    });
    const claimed = await claim(db, clock, ["poll"]);
    const next =
      claimed === null
        ? null
        : await failJob(sqliteDb(db), claimed, new Error("blip"), { now: clock.now() });
    expect(next?.status).toBe("pending");
    expect(next?.attempts).toBe(0);
    expect(next?.fireCount).toBe(0);
    expect(next?.lastError).toBe("blip");
    expect(next?.runAt).toBe(clock.now() + 5_000);
    expect((await listJobs(sqliteDb(db))).filter((job) => job.status === "dead")).toHaveLength(0);
    expect(next?.id).toBe(created);
  });

  test("a retry waits out the error's retryAfterMs when it is longer than the backoff", async () => {
    const { db, clock } = queue();
    await enqueueJob(sqliteDb(db), { queue: "work", now: clock.now() });
    const claimed = await claim(db, clock, ["work"]);
    const rateLimited = Object.assign(new Error("rate limited"), { retryAfterMs: 90_000 });
    const next =
      claimed === null
        ? null
        : await failJob(sqliteDb(db), claimed, rateLimited, { now: clock.now() });
    expect(next?.status).toBe("pending");
    expect(next?.runAt).toBe(clock.now() + 90_000);
  });

  test("two connections never claim the same row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "paws-jobs-"));
    const path = join(dir, "paws.db");
    const clock = new FakeClock(0);
    const left = openDatabase(path);
    const right = openDatabase(path);
    migrate(left);
    migrate(right);
    for (let index = 0; index < 20; index += 1) {
      await enqueueJob(sqliteDb(left), { queue: "tick", jobKey: `job-${index}`, now: clock.now() });
    }
    const claimed: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const job = await claimNextJob(sqliteDb(index % 2 === 0 ? left : right), {
        workerId: index % 2 === 0 ? "left" : "right",
        now: clock.now(),
        queues: ["tick"],
      });
      expect(job).not.toBeNull();
      if (job) claimed.push(job.id);
    }
    expect(new Set(claimed).size).toBe(20);
    expect(await claim(left, clock, ["tick"], "left")).toBeNull();
    expect(await claim(right, clock, ["tick"], "right")).toBeNull();
    left.close();
    right.close();
  });

  test("a ready start needs its own reservation", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    const id = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.start,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    expect(await claim(db, clock, [JOB_KIND.start])).toBeNull();
    db.run(
      "INSERT INTO scheduler_admission(item_id,job_id,project_key,repository_key,paths,hot,created_at) VALUES(?,?,'*','repo','[]',0,?)",
      ["eng-1", id, clock.now()],
    );
    expect((await claim(db, clock, [JOB_KIND.start]))?.id).toBe(id);
  });

  test("a queued start with old capacity bookkeeping still needs admission", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    const id = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.start,
      payload: {
        itemId: "eng-1",
        capacityWait: { since: clock.now(), attempt: 0, runnerIds: ["busy"] },
      },
      now: clock.now(),
    });
    expect(await claim(db, clock, [JOB_KIND.start])).toBeNull();
    db.run(
      "INSERT INTO scheduler_admission(item_id,job_id,project_key,repository_key,paths,hot,created_at) VALUES(?,?,'*','repo','[]',0,?)",
      ["eng-1", id, clock.now()],
    );
    expect((await claim(db, clock, [JOB_KIND.start]))?.id).toBe(id);
    db.close();
  });

  test("a start parked for a runner slot is claimed again after the item is running", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    await beginImplementRun(sqliteDb(db), "eng-1", clock.now());
    const parked = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.start,
      payload: {
        itemId: "eng-1",
        capacityWait: { since: clock.now(), attempt: 0, runnerIds: ["runner-1"] },
      },
      now: clock.now(),
    });
    expect((await claim(db, clock, [JOB_KIND.start]))?.id).toBe(parked);
  });

  test("the in-flight item can resume while another start waits", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    insertQueuedItem(db, { id: "eng-2", now: clock.now() });
    await beginImplementRun(sqliteDb(db), "eng-1", clock.now());
    await applyWorkItemEvent(sqliteDb(db), "eng-1", "lease_expired");
    await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.start,
      payload: { itemId: "eng-2" },
      priority: 0,
      now: clock.now(),
    });
    await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.resume,
      payload: { itemId: "eng-1" },
      priority: 5,
      now: clock.now(),
    });
    const claimed = await claim(db, clock, [JOB_KIND.start, JOB_KIND.resume]);
    expect(claimed?.queue).toBe(JOB_KIND.resume);
    expect(claimed?.payload).toEqual({ itemId: "eng-1" });
    expect(await claim(db, clock, [JOB_KIND.start])).toBeNull();
  });

  test("two merge jobs for different repositories are both claimed", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    insertQueuedItem(db, { id: "eng-2", now: clock.now() });
    await bindRepo(db, "eng-1", "acme", "one");
    await bindRepo(db, "eng-2", "acme", "two");
    await enqueueMerge(db, clock, "eng-1");
    await enqueueMerge(db, clock, "eng-2");
    const first = await claim(db, clock, [JOB_KIND.merge]);
    const second = await claim(db, clock, [JOB_KIND.merge]);
    expect(first?.payload).toEqual({ itemId: "eng-1" });
    expect(second?.payload).toEqual({ itemId: "eng-2" });
    expect(first?.status).toBe("running");
    expect(second?.status).toBe("running");
  });

  test("a second merge job for the same repository is not claimed", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    insertQueuedItem(db, { id: "eng-2", now: clock.now() });
    await bindRepo(db, "eng-1", "acme", "one");
    await bindRepo(db, "eng-2", "Acme", "ONE");
    await holdMergeQueuePlace(db, clock, "eng-1");
    await enqueueMerge(db, clock, "eng-1");
    await enqueueMerge(db, clock, "eng-2");
    expect((await claim(db, clock, [JOB_KIND.merge]))?.payload).toEqual({ itemId: "eng-1" });
    expect(await claim(db, clock, [JOB_KIND.merge])).toBeNull();
  });

  test("merge jobs in one repository's different project lanes are both claimed, each first in its lane", async () => {
    const { db, clock } = queue();
    for (const id of ["eng-1", "eng-2"]) {
      insertQueuedItem(db, { id, now: clock.now() });
      await bindRepo(db, id, "acme", "one");
    }
    await holdMergeQueuePlace(db, clock, "eng-1", "project-a");
    await holdMergeQueuePlace(db, clock, "eng-2", "project-b");
    await enqueueMerge(db, clock, "eng-1");
    await enqueueMerge(db, clock, "eng-2");
    expect((await claim(db, clock, [JOB_KIND.merge]))?.payload).toEqual({ itemId: "eng-1" });
    expect((await claim(db, clock, [JOB_KIND.merge]))?.payload).toEqual({ itemId: "eng-2" });
    expect(
      listMergeQueues(db).map((entry) => [entry.itemId, entry.lane, entry.position, entry.total]),
    ).toEqual([
      ["eng-1", "project-a", 1, 1],
      ["eng-2", "project-b", 1, 1],
    ]);
  });

  test("a second merge job in the same project lane is not claimed", async () => {
    const { db, clock } = queue();
    for (const id of ["eng-1", "eng-2"]) {
      insertQueuedItem(db, { id, now: clock.now() });
      await bindRepo(db, id, "acme", "one");
    }
    await holdMergeQueuePlace(db, clock, "eng-1", "project-a");
    await holdMergeQueuePlace(db, clock, "eng-2", "project-a");
    await enqueueMerge(db, clock, "eng-1");
    await enqueueMerge(db, clock, "eng-2");
    expect((await claim(db, clock, [JOB_KIND.merge]))?.payload).toEqual({ itemId: "eng-1" });
    expect(await claim(db, clock, [JOB_KIND.merge])).toBeNull();
    expect(
      listMergeQueues(db).map((entry) => [entry.itemId, entry.position, entry.aheadItemId]),
    ).toEqual([
      ["eng-1", 1, null],
      ["eng-2", 2, "eng-1"],
    ]);
  });

  test("a merge job with no queue place yet waits only for the repository-wide lane", async () => {
    const { db, clock } = queue();
    for (const id of ["eng-1", "eng-2", "eng-3"]) {
      insertQueuedItem(db, { id, now: clock.now() });
      await bindRepo(db, id, "acme", "one");
    }
    await holdMergeQueuePlace(db, clock, "eng-1", "project-a");
    await enqueueMerge(db, clock, "eng-1");
    await enqueueMerge(db, clock, "eng-2");
    expect((await claim(db, clock, [JOB_KIND.merge]))?.payload).toEqual({ itemId: "eng-1" });
    const unplaced = await claim(db, clock, [JOB_KIND.merge]);
    expect(unplaced?.payload).toEqual({ itemId: "eng-2" });
    expect(unplaced !== null && (await completeJob(sqliteDb(db), unplaced, clock.now()))).toBe(
      true,
    );

    await holdMergeQueuePlace(db, clock, "eng-3");
    await enqueueMerge(db, clock, "eng-3");
    expect((await claim(db, clock, [JOB_KIND.merge]))?.payload).toEqual({ itemId: "eng-3" });
    await enqueueMerge(db, clock, "eng-2");
    expect(await claim(db, clock, [JOB_KIND.merge])).toBeNull();
  });

  test("a merge job whose item waits outside the merge queue does not hold the lane", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    insertQueuedItem(db, { id: "eng-2", now: clock.now() });
    await bindRepo(db, "eng-1", "acme", "one");
    await bindRepo(db, "eng-2", "acme", "one");
    await holdMergeQueuePlace(db, clock, "eng-1");
    await leaveMergeQueue(sqliteDb(db), "eng-1");
    await enqueueMerge(db, clock, "eng-1");
    await enqueueMerge(db, clock, "eng-2");
    expect((await claim(db, clock, [JOB_KIND.merge]))?.payload).toEqual({ itemId: "eng-1" });
    expect((await claim(db, clock, [JOB_KIND.merge]))?.payload).toEqual({ itemId: "eng-2" });
  });

  test("a start job is claimed while a merge job is running", async () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    insertQueuedItem(db, { id: "eng-2", now: clock.now() });
    await bindRepo(db, "eng-1", "acme", "one");
    await enqueueMerge(db, clock, "eng-1");
    expect((await claim(db, clock, [JOB_KIND.merge]))?.payload).toEqual({ itemId: "eng-1" });
    await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.start,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    const startId = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.start,
      payload: { itemId: "eng-2" },
      now: clock.now(),
    });
    db.run(
      "INSERT INTO scheduler_admission(item_id,job_id,project_key,repository_key,paths,hot,created_at) VALUES(?, ?, '*', 'repo', '[]',0,?)",
      ["eng-2", startId, clock.now()],
    );
    expect((await claim(db, clock, [JOB_KIND.start]))?.payload).toEqual({ itemId: "eng-2" });
  });

  test("an open dedupe key collapses to one pending row", async () => {
    const { db, clock } = queue();
    const first = await enqueueJobOnce(sqliteDb(db), {
      queue: "tick",
      jobKey: "poller",
      now: clock.now(),
    });
    const second = await enqueueJobOnce(sqliteDb(db), {
      queue: "tick",
      jobKey: "poller",
      now: clock.now(),
    });
    expect(second).toBe(first);
    expect(await listJobs(sqliteDb(db))).toHaveLength(1);
  });
});

for (const operation of ["complete", "fail", "extend"] as const) {
  for (const scenario of ["reclaimed", "recurring-failure", "cancelled"] as const) {
    test(`stale ${operation} cannot change a ${scenario} claim with a reused worker identity`, async () => {
      const { db, clock } = queue();
      const id = await enqueueJob(sqliteDb(db), {
        queue: "work",
        now: clock.now(),
        ...(scenario === "recurring-failure" ? { recurringEveryMs: 1, maxAttempts: 1 } : {}),
      });
      const first = (await claim(db, clock, ["work"]))!;
      if (scenario === "reclaimed") clock.advance(5_000);
      if (scenario === "recurring-failure") {
        expect(
          await failJob(sqliteDb(db), first, new Error("first fire failed"), { now: clock.now() }),
        ).not.toBeNull();
        clock.advance(1);
      }
      if (scenario === "cancelled")
        db.run(
          "UPDATE job SET status = 'cancelled', locked_by = NULL, locked_until = NULL WHERE id = ?",
          [id],
        );
      if (scenario === "reclaimed" || scenario === "recurring-failure") {
        const replacement = (await claim(db, clock, ["work"]))!;
        expect(replacement).not.toBeNull();
      }
      const before = await getJob(sqliteDb(db), id);
      const changed =
        operation === "complete"
          ? await completeJob(sqliteDb(db), first, clock.now())
          : operation === "fail"
            ? await failJob(sqliteDb(db), first, new Error("stale failure"), { now: clock.now() })
            : await extendJobLease(sqliteDb(db), first, clock.now(), 60_000);
      expect(changed).toBe(operation === "fail" ? null : false);
      expect(await getJob(sqliteDb(db), id)).toEqual(before);
      db.close();
    });
  }
}

for (const operation of ["complete", "fail", "extend"] as const) {
  test(`a late ${operation} still applies when nobody reclaimed the expired claim`, async () => {
    const { db, clock } = queue();
    const id = await enqueueJob(sqliteDb(db), { queue: "work", now: clock.now() });
    const first = (await claim(db, clock, ["work"]))!;
    clock.advance(5_000);
    const changed =
      operation === "complete"
        ? await completeJob(sqliteDb(db), first, clock.now())
        : operation === "fail"
          ? await failJob(sqliteDb(db), first, new Error("late failure"), { now: clock.now() })
          : await extendJobLease(sqliteDb(db), first, clock.now(), 60_000);
    expect(changed).toBeTruthy();
    expect((await getJob(sqliteDb(db), id))?.status).toBe(
      operation === "complete" ? "done" : operation === "fail" ? "pending" : "running",
    );
    db.close();
  });
}

describe("leased job writes", () => {
  test("parking a leased job keeps the earlier run_at, sets the payload, and frees the lease", async () => {
    const { db, clock, leaseMs } = queue();
    const id = await enqueueJob(sqliteDb(db), { queue: "x", payload: { a: 1 }, now: clock.now() });
    const job = (await claimNextJob(sqliteDb(db), { now: clock.now(), leaseMs }))!;
    expect(
      await parkLeasedJob(sqliteDb(db), job, {
        runAt: clock.now() + 10_000,
        payload: { a: 2 },
        attempts: -1,
        now: clock.now(),
      }),
    ).toBe(true);
    expect(await getJob(sqliteDb(db), id)).toMatchObject({
      status: "pending",
      runAt: clock.now() + 10_000,
      attempts: 0,
      lockedBy: null,
      payload: { a: 2 },
    });
  });

  test("a park or retry after the lease expired or moved on is lost", async () => {
    const { db, clock, leaseMs } = queue();
    await enqueueJob(sqliteDb(db), { queue: "x", now: clock.now() });
    const job = (await claimNextJob(sqliteDb(db), { now: clock.now(), leaseMs }))!;
    clock.advance(leaseMs + 1);
    expect(
      await parkLeasedJob(sqliteDb(db), job, {
        runAt: clock.now(),
        payload: {},
        attempts: 0,
        now: clock.now(),
      }),
    ).toBe(false);
    const again = (await claimNextJob(sqliteDb(db), { now: clock.now(), leaseMs }))!;
    expect(await retryLeasedJob(sqliteDb(db), job, clock.now() + 1_000, "boom")).toBe(false);
    expect(await retryLeasedJob(sqliteDb(db), again, clock.now() + 1_000, "boom")).toBe(true);
    expect(await getJob(sqliteDb(db), again.id)).toMatchObject({
      status: "pending",
      lastError: "boom",
    });
  });
});

test.each(["done", "cancelled", "dead"] as const)(
  "explicit revival refreshes a %s row while lifetime dedupe retains it",
  async (status) => {
    const { db } = queue();
    insertQueuedItem(db, { id: "revive", now: 1 });
    const original = {
      queue: "test",
      jobKey: "revive",
      payload: { itemId: "revive", body: "old" },
      now: 1,
    };
    const id = await enqueueJobOnce(sqliteDb(db), original);
    db.run("UPDATE job SET status=?, attempts=7, finished_at=2, last_error='old' WHERE id=?", [
      status,
      id,
    ]);
    db.run("UPDATE work_item SET version=version+1 WHERE id='revive'");
    const fresh = { ...original, payload: { itemId: "revive", body: "new" }, now: 3 };
    expect(await enqueueJobOnce(sqliteDb(db), fresh)).toBe(id);
    expect(await getJob(sqliteDb(db), id)).toMatchObject({
      status,
      attempts: 7,
      payload: original.payload,
    });
    expect(await reenqueueJob(sqliteDb(db), fresh)).toEqual({ id, pending: true });
    expect(await getJob(sqliteDb(db), id)).toMatchObject({
      status: "pending",
      attempts: 0,
      runAt: 3,
      finishedAt: null,
      lastError: null,
      payload: fresh.payload,
    });
    expect(await jobVersionCurrent(sqliteDb(db), (await getJob(sqliteDb(db), id))!)).toBe(true);
    expect(await reenqueueJob(sqliteDb(db), { ...fresh, now: 4, payload: {} })).toEqual({
      id,
      pending: true,
    });
    expect((await getJob(sqliteDb(db), id))?.payload).toEqual(fresh.payload);
    const leased = (await claimNextJob(sqliteDb(db), { now: 4, queues: ["test"] }))!;
    expect(await reenqueueJob(sqliteDb(db), { ...fresh, now: 5, payload: {} })).toEqual({
      id,
      pending: false,
    });
    expect(await getJob(sqliteDb(db), id)).toEqual(leased);
    expect(await listJobs(sqliteDb(db))).toHaveLength(1);
    db.close();
  },
);
