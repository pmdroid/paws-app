import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  enqueueJob,
  ensureLinearSession,
  insertQueuedItem,
  listJobs,
  listOutbox,
} from "../src/db";
import { registerScheduler } from "../src/scheduler";
import { workspaceDispatchPg } from "./fake-workspace";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const GRACE_MS = 5 * 60_000;

test("one scheduler tick requeues an orphan and admits its resume in the same pass", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(1_000_000);
  try {
    await ensureLinearSession(db, {
      sessionId: "orphan-session",
      issueId: "orphan-parent",
      now: 1,
    });
    await insertQueuedItem(db, { id: "orphan", now: 1, sessionKey: "orphan-session" });
    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ state: "running" }).where(eq(q.t.workItem.id, "orphan")),
    );
    const finished = await enqueueJob(db, {
      queue: JOB_KIND.start,
      payload: { itemId: "orphan" },
      now: 1,
    });
    await seed(db, (q) =>
      q.orm
        .update(q.t.job)
        .set({ status: "done", finishedAt: clock.now() - GRACE_MS - 1 })
        .where(eq(q.t.job.id, finished)),
    );
    await insertQueuedItem(db, { id: "next", now: 2 });
    const jobs = new JobLoop(db, clock);
    const ticks: string[][] = [];
    await registerScheduler(
      jobs,
      async () => {
        ticks.push(await workspaceDispatchPg(db, { now: clock.now() }));
      },
      clock.now(),
    );

    const tick = await jobs.tick(["scheduler.tick"]);
    expect(tick?.queue).toBe("scheduler.tick");
    const resume = (await listJobs(db)).filter(
      (job) => job.queue === JOB_KIND.resume && job.status === "pending",
    );
    expect(resume).toHaveLength(1);
    expect(resume[0]!.payload).toMatchObject({
      itemId: "orphan",
      freshSession: true,
      reason: "orphaned",
    });
    expect(
      await db.run((q) =>
        q.one(
          q.orm
            .select({ itemId: q.t.schedulerAdmission.itemId, jobId: q.t.schedulerAdmission.jobId })
            .from(q.t.schedulerAdmission)
            .where(eq(q.t.schedulerAdmission.itemId, "orphan")),
        ),
      ),
    ).toEqual({ itemId: "orphan", jobId: resume[0]!.id });
    expect(ticks).toEqual([["next"]]);
    expect(
      (await listOutbox(db))
        .filter((row) => row.idempotencyKey.startsWith("orphan:orphan:"))
        .map((row) => (row.payload as { body?: string }).body),
    ).toEqual(["Nothing was moving orphan forward, so Paws picked it up again."]);

    const claimed: string[] = [];
    jobs.register(JOB_KIND.resume, (job) => {
      claimed.push((job.payload as { itemId: string }).itemId);
    });
    expect((await jobs.tick([JOB_KIND.resume]))?.queue).toBe(JOB_KIND.resume);
    expect(claimed).toEqual(["orphan"]);
  } finally {
    await close();
  }
});
