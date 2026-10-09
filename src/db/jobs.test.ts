import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, JOB_KIND } from "../core";
import {
  applyWorkItemEvent,
  beginImplementRun,
  claimJobSql,
  claimNextJob,
  completeJob,
  enqueueJob,
  enqueueJobOnce,
  failJob,
  getJob,
  insertQueuedItem,
  listJobs,
  migrate,
  openDatabase,
} from "./index";

function queue(clock = new FakeClock(1_000), leaseMs = 5_000) {
  const db = openDatabase(":memory:");
  migrate(db);
  return { db, clock, leaseMs };
}

function claim(
  db: ReturnType<typeof queue>["db"],
  clock: FakeClock,
  queues: string[],
  workerId = "worker",
  leaseMs = 5_000,
) {
  return claimNextJob(db, { workerId, leaseMs, now: clock.now(), queues });
}

describe("job queue", () => {
  test("claims with one UPDATE ... RETURNING statement", () => {
    const sql = claimJobSql(2);
    expect(sql).toContain("UPDATE job");
    expect(sql).toContain("RETURNING *");
    expect(sql).not.toContain(";");
  });

  test("a timer row stays unclaimed until its run_at", () => {
    const { db, clock } = queue();
    enqueueJob(db, { queue: "tick", runAt: clock.now() + 5_000, now: clock.now() });
    expect(claim(db, clock, ["tick"])).toBeNull();
    clock.advance(5_000);
    expect(claim(db, clock, ["tick"])?.queue).toBe("tick");
  });

  test("an unregistered queue does not block a job this process can run", () => {
    const { db, clock } = queue();
    enqueueJob(db, { queue: "mystery", now: clock.now() });
    enqueueJob(db, { queue: "work", now: clock.now() });
    const claimed = claim(db, clock, ["work"]);
    expect(claimed?.queue).toBe("work");
    expect(listJobs(db).find((job) => job.queue === "mystery")?.status).toBe("pending");
  });

  test("stop commands are claimed ahead of other due work", () => {
    const { db, clock } = queue();
    enqueueJob(db, { queue: "work", now: clock.now() });
    enqueueJob(db, { queue: "core.command", priority: 0, now: clock.now() });
    expect(claim(db, clock, ["work", "core.command"])?.queue).toBe("core.command");
  });

  test("a second worker cannot take a live lease, and an expired lease can be reclaimed", () => {
    const { db, clock } = queue(new FakeClock(0), 1_000);
    enqueueJob(db, { queue: "work", maxAttempts: 5, now: clock.now() });
    const first = claim(db, clock, ["work"], "a", 1_000);
    expect(first).not.toBeNull();
    clock.advance(999);
    expect(claim(db, clock, ["work"], "b", 1_000)).toBeNull();
    clock.advance(1);
    const second = claim(db, clock, ["work"], "b", 1_000);
    expect(second?.id).toBe(first?.id);
    expect(second?.attempts).toBe(2);
    expect(first !== null && completeJob(db, first, clock.now())).toBe(false);
    expect(second !== null && completeJob(db, second, clock.now())).toBe(true);
    expect(second !== null && getJob(db, second.id)?.status).toBe("done");
  });

  test("retries with backoff and then fails the job", () => {
    const { db, clock } = queue();
    const created = enqueueJob(db, { queue: "work", maxAttempts: 2, now: clock.now() });
    const first = claim(db, clock, ["work"]);
    expect(first).not.toBeNull();
    const retried =
      first === null ? null : failJob(db, first, new Error("nope"), { now: clock.now() });
    expect(retried?.status).toBe("pending");
    expect(retried?.runAt).toBe(clock.now() + 1_000);
    expect(claim(db, clock, ["work"])).toBeNull();
    clock.advance(1_000);
    const second = claim(db, clock, ["work"]);
    expect(second?.attempts).toBe(2);
    expect(
      second !== null && failJob(db, second, new Error("still nope"), { now: clock.now() })?.status,
    ).toBe("dead");
    expect(
      listJobs(db)
        .filter((job) => job.status === "dead")
        .map((job) => job.id),
    ).toEqual([created]);
    expect(claim(db, clock, ["work"])).toBeNull();
  });

  test("a recurring row arms its next fire after success", () => {
    const { db, clock } = queue();
    enqueueJob(db, { queue: "poll", recurringEveryMs: 5_000, now: clock.now() });
    const first = claim(db, clock, ["poll"]);
    expect(first !== null && completeJob(db, first, clock.now())).toBe(true);
    const armed = first === null ? null : getJob(db, first.id);
    expect(armed?.status).toBe("pending");
    expect(armed?.fireCount).toBe(1);
    expect(armed?.attempts).toBe(0);
    expect(armed?.runAt).toBe(clock.now() + 5_000);
    clock.advance(4_999);
    expect(claim(db, clock, ["poll"])).toBeNull();
    clock.advance(1);
    const second = claim(db, clock, ["poll"]);
    expect(second !== null && completeJob(db, second, clock.now())).toBe(true);
    expect(first !== null && getJob(db, first.id)?.fireCount).toBe(2);
  });

  test("a recurring row that exhausts its attempts still arms the next fire", () => {
    const { db, clock } = queue();
    const created = enqueueJob(db, {
      queue: "poll",
      recurringEveryMs: 5_000,
      maxAttempts: 1,
      now: clock.now(),
    });
    const claimed = claim(db, clock, ["poll"]);
    const next =
      claimed === null ? null : failJob(db, claimed, new Error("blip"), { now: clock.now() });
    expect(next?.status).toBe("pending");
    expect(next?.attempts).toBe(0);
    expect(next?.fireCount).toBe(0);
    expect(next?.lastError).toBe("blip");
    expect(next?.runAt).toBe(clock.now() + 5_000);
    expect(listJobs(db).filter((job) => job.status === "dead")).toHaveLength(0);
    expect(next?.id).toBe(created);
  });

  test("two connections never claim the same row", () => {
    const dir = mkdtempSync(join(tmpdir(), "paws-jobs-"));
    const path = join(dir, "paws.db");
    const clock = new FakeClock(0);
    const left = openDatabase(path);
    const right = openDatabase(path);
    migrate(left);
    migrate(right);
    for (let index = 0; index < 20; index += 1) {
      enqueueJob(left, { queue: "tick", jobKey: `job-${index}`, now: clock.now() });
    }
    const claimed: number[] = [];
    for (let index = 0; index < 20; index += 1) {
      const job = claimNextJob(index % 2 === 0 ? left : right, {
        workerId: index % 2 === 0 ? "left" : "right",
        now: clock.now(),
        queues: ["tick"],
      });
      expect(job).not.toBeNull();
      if (job) claimed.push(job.id);
    }
    expect(new Set(claimed).size).toBe(20);
    expect(claim(left, clock, ["tick"], "left")).toBeNull();
    expect(claim(right, clock, ["tick"], "right")).toBeNull();
    left.close();
    right.close();
  });

  test("two ready items never run at once", () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    insertQueuedItem(db, { id: "eng-2", now: clock.now() });
    enqueueJob(db, {
      queue: JOB_KIND.start,
      payload: { itemId: "eng-1" },
      now: clock.now(),
    });
    enqueueJob(db, {
      queue: JOB_KIND.start,
      payload: { itemId: "eng-2" },
      now: clock.now(),
    });
    enqueueJob(db, { queue: JOB_KIND.catchup, priority: 9, now: clock.now() });

    const first = claim(db, clock, [JOB_KIND.start, JOB_KIND.catchup]);
    expect(first?.payload).toEqual({ itemId: "eng-1" });
    expect(claim(db, clock, [JOB_KIND.start, JOB_KIND.catchup])?.queue).toBe(JOB_KIND.catchup);
    expect(claim(db, clock, [JOB_KIND.start])).toBeNull();

    if (first === null) throw new Error("missing claim");
    expect(completeJob(db, first, clock.now())).toBe(true);
    beginImplementRun(db, "eng-1", clock.now());
    expect(claim(db, clock, [JOB_KIND.start])).toBeNull();

    applyWorkItemEvent(db, "eng-1", "cancel");
    expect(claim(db, clock, [JOB_KIND.start])?.payload).toEqual({ itemId: "eng-2" });
  });

  test("the in-flight item can resume while another start waits", () => {
    const { db, clock } = queue();
    insertQueuedItem(db, { id: "eng-1", now: clock.now() });
    insertQueuedItem(db, { id: "eng-2", now: clock.now() });
    beginImplementRun(db, "eng-1", clock.now());
    applyWorkItemEvent(db, "eng-1", "lease_expired");
    enqueueJob(db, {
      queue: JOB_KIND.start,
      payload: { itemId: "eng-2" },
      priority: 0,
      now: clock.now(),
    });
    enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId: "eng-1" },
      priority: 5,
      now: clock.now(),
    });
    const claimed = claim(db, clock, [JOB_KIND.start, JOB_KIND.resume]);
    expect(claimed?.queue).toBe(JOB_KIND.resume);
    expect(claimed?.payload).toEqual({ itemId: "eng-1" });
    expect(claim(db, clock, [JOB_KIND.start])).toBeNull();
  });

  test("an open dedupe key collapses to one pending row", () => {
    const { db, clock } = queue();
    const first = enqueueJobOnce(db, { queue: "tick", jobKey: "poller", now: clock.now() });
    const second = enqueueJobOnce(db, { queue: "tick", jobKey: "poller", now: clock.now() });
    expect(second).toBe(first);
    expect(listJobs(db)).toHaveLength(1);
  });
});
